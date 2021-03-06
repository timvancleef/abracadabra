import { Code, Modification } from "../../editor/editor";
import { Selection } from "../../editor/selection";
import * as ast from "../../ast";
import { last } from "../../array-helpers";

import { findExportedIdNames } from "./find-exported-id-names";

export {
  findInlinableCode,
  InlinableCode,
  InlinableTSTypeAlias,
  InlinableObjectPattern,
  SingleDeclaration,
  MultipleDeclarations
};

function findInlinableCode(
  selection: Selection,
  parent: ast.Node,
  declaration: Declaration
): InlinableCode | null {
  const { id, init } = declaration;
  if (!ast.isSelectableNode(init)) return null;

  if (ast.isSelectableIdentifier(id)) {
    return new InlinableIdentifier(id, parent, init.loc);
  }

  if (ast.isObjectPattern(id)) {
    if (!ast.isSelectableNode(id)) return null;

    let result: InlinableCode | null = null;
    id.properties.forEach((property, index) => {
      if (!selection.isInsideNode(property)) return;
      if (ast.isRestElement(property)) return;
      if (!ast.isSelectableObjectProperty(property)) return;

      const child = findInlinableCode(selection, parent, {
        id: property.value,
        init: property
      });
      if (!child) return;

      const initName = getInitName(init);
      if (!initName) return;

      const previous = id.properties[index - 1];
      const next = id.properties[index + 1];
      const hasRestSibling = id.properties.some(p => ast.isRestElement(p));

      result = new InlinableObjectPattern(
        child,
        initName,
        property,
        hasRestSibling,
        previous,
        next
      );
    });

    return wrapInTopLevelPattern(result, declaration, id.loc);
  }

  if (ast.isArrayPattern(id)) {
    if (!ast.isSelectableNode(id)) return null;

    let result: InlinableCode | null = null;
    id.elements.forEach((element, index) => {
      if (!element) return;
      if (!selection.isInsideNode(element)) return;
      if (!ast.isSelectableNode(element)) return;

      const child = findInlinableCode(selection, parent, {
        id: element,
        init
      });
      if (!child) return;

      const previous = id.elements[index - 1];
      const next = id.elements[index + 1];

      result = new InlinableArrayPattern(child, index, element, previous, next);
    });

    return wrapInTopLevelPattern(result, declaration, id.loc);
  }

  return null;
}

function getInitName(init: ast.Node): string | null {
  if (ast.isIdentifier(init)) return init.name;

  if (ast.isMemberExpression(init)) {
    const { property, computed } = init;

    const propertyName = ast.isNumericLiteral(property)
      ? `[${property.value}]`
      : ast.isStringLiteral(property)
      ? `["${property.value}"]`
      : ast.isIdentifier(property) && computed
      ? `[${property.name}]`
      : `.${getInitName(property)}`;

    if (property.value === null && getInitName(property) === null) {
      // We can't resolve property name. Stop here.
      return null;
    }

    return `${getInitName(init.object)}${propertyName}`;
  }

  if (ast.isObjectProperty(init)) {
    return getInitName(init.key);
  }

  if (ast.isThisExpression(init)) {
    return "this";
  }

  return null;
}

function wrapInTopLevelPattern(
  child: InlinableCode | null,
  declaration: Declaration,
  loc: ast.SourceLocation
): InlinableCode | null {
  if (!child) return child;

  const isTopLevelObjectPattern = ast.isVariableDeclarator(declaration);

  return isTopLevelObjectPattern
    ? new InlinableTopLevelPattern(child, loc)
    : child;
}

type Declaration = { id: ast.Node; init: ast.Node | null };

// 🎭 Component interface

interface InlinableCode {
  isRedeclared: boolean;
  isExported: boolean;
  hasIdentifiersToUpdate: boolean;
  shouldExtendSelectionToDeclaration: boolean;
  valueSelection: Selection;
  codeToRemoveSelection: Selection;
  updateIdentifiersWith: (inlinedCode: Code) => Modification[];
}

// 🍂 Leaves

class InlinableIdentifier implements InlinableCode {
  shouldExtendSelectionToDeclaration = true;
  valueSelection: Selection;

  private id: ast.SelectableIdentifier;
  private scope: ast.Node;
  private identifiersToReplace: IdentifierToReplace[] = [];

  constructor(
    id: ast.SelectableIdentifier,
    scope: ast.Node,
    valueLoc: ast.SourceLocation
  ) {
    this.id = id;
    this.scope = scope;
    this.valueSelection = Selection.fromAST(valueLoc);
    this.computeIdentifiersToReplace();
  }

  get isRedeclared(): boolean {
    let result = false;

    // We have to alias `this` because traversal rebinds the context of the options.
    const self = this;
    ast.traverseNode(this.scope, {
      enter(node) {
        if (!ast.isAssignmentExpression(node)) return;
        if (!ast.areEqual(self.id, node.left)) return;

        result = true;
      }
    });

    return result;
  }

  get isExported(): boolean {
    return findExportedIdNames(this.scope).includes(this.id.name);
  }

  get hasIdentifiersToUpdate(): boolean {
    return this.identifiersToReplace.length > 0;
  }

  get codeToRemoveSelection(): Selection {
    return this.valueSelection.extendStartToStartOf(
      Selection.fromAST(this.id.loc)
    );
  }

  updateIdentifiersWith(inlinedCode: Code): Modification[] {
    return this.identifiersToReplace.map(
      ({ loc, isInUnaryExpression, shorthandKey }) => ({
        code: isInUnaryExpression
          ? `(${inlinedCode})`
          : shorthandKey
          ? `${shorthandKey}: ${inlinedCode}`
          : inlinedCode,
        selection: Selection.fromAST(loc)
      })
    );
  }

  private computeIdentifiersToReplace() {
    // We have to alias `this` because traversal rebinds the context of the options.
    const self = this;
    ast.traverseNode(this.scope, {
      enter(node, ancestors) {
        if (!ast.isSelectableNode(node)) return;
        if (!ast.areEqual(self.id, node)) return;
        if (ast.isShadowIn(self.id, ancestors)) return;

        const selection = Selection.fromAST(node.loc);
        const isSameIdentifier = selection.isInsideNode(self.id);
        if (isSameIdentifier) return;

        const parent = last(ancestors);
        if (!parent) return;
        if (ast.isFunctionDeclaration(parent)) return;
        if (ast.isObjectProperty(parent.node) && parent.node.key === node) {
          return;
        }
        if (
          ast.isMemberExpression(parent.node) &&
          parent.node.property === node
        ) {
          return;
        }

        self.identifiersToReplace.push({
          loc: node.loc,
          isInUnaryExpression: ast.isUnaryExpression(parent.node),
          shorthandKey:
            ast.isObjectProperty(parent.node) &&
            parent.node.shorthand &&
            ast.isIdentifier(node)
              ? node.name
              : null
        });
      }
    });
  }
}

class InlinableTSTypeAlias implements InlinableCode {
  shouldExtendSelectionToDeclaration = true;
  codeToRemoveSelection: Selection;
  valueSelection: Selection;

  // Type aliases can't be redeclared.
  isRedeclared = false;

  private path: ast.SelectablePath<ast.TSTypeAliasDeclaration>;
  private refToReplaceLocs: ast.SourceLocation[] = [];

  constructor(
    path: ast.SelectablePath<ast.TSTypeAliasDeclaration>,
    valueLoc: ast.SourceLocation
  ) {
    this.path = path;
    this.codeToRemoveSelection = Selection.fromAST(path.node.loc);
    this.valueSelection = Selection.fromAST(valueLoc);
    this.computeIdentifiersToReplace();
  }

  get isExported(): boolean {
    return findExportedIdNames(this.path.parent).includes(
      this.path.node.id.name
    );
  }

  get hasIdentifiersToUpdate(): boolean {
    return this.refToReplaceLocs.length > 0;
  }

  updateIdentifiersWith(inlinedCode: Code): Modification[] {
    return this.refToReplaceLocs.map(loc => ({
      code: inlinedCode,
      selection: Selection.fromAST(loc)
    }));
  }

  private computeIdentifiersToReplace() {
    // Alias `this` because traversal rebinds the context of the options.
    const self = this;
    this.path.parentPath.traverse({
      TSTypeReference(path) {
        if (!ast.isSelectablePath(path)) return;
        if (!ast.areEqual(self.path.node.id, path.node.typeName)) return;

        self.refToReplaceLocs.push(path.node.loc);
      }
    });
  }
}

interface IdentifierToReplace {
  loc: ast.SourceLocation;
  isInUnaryExpression: boolean;
  shorthandKey: string | null;
}

// 📦 Composites

class CompositeInlinable implements InlinableCode {
  protected child: InlinableCode;

  constructor(child: InlinableCode) {
    this.child = child;
  }

  get isRedeclared(): boolean {
    return this.child.isRedeclared;
  }

  get isExported(): boolean {
    return this.child.isExported;
  }

  get hasIdentifiersToUpdate(): boolean {
    return this.child.hasIdentifiersToUpdate;
  }

  get shouldExtendSelectionToDeclaration(): boolean {
    return this.child.shouldExtendSelectionToDeclaration;
  }

  get valueSelection(): Selection {
    return this.child.valueSelection;
  }

  get codeToRemoveSelection(): Selection {
    return this.child.codeToRemoveSelection;
  }

  updateIdentifiersWith(inlinedCode: Code): Modification[] {
    return this.child.updateIdentifiersWith(inlinedCode);
  }
}
class SingleDeclaration extends CompositeInlinable {
  get codeToRemoveSelection(): Selection {
    const selection = super.codeToRemoveSelection;

    if (!super.shouldExtendSelectionToDeclaration) {
      return selection;
    }

    return selection.extendToStartOfLine().extendToStartOfNextLine();
  }
}

class MultipleDeclarations extends CompositeInlinable {
  private previous: ast.SelectableNode;
  private next: ast.SelectableNode | undefined;

  constructor(
    child: InlinableCode,
    previous: ast.SelectableNode,
    next?: ast.SelectableNode
  ) {
    super(child);
    this.previous = previous;
    this.next = next;
  }

  get codeToRemoveSelection(): Selection {
    const selection = super.codeToRemoveSelection;

    if (!super.shouldExtendSelectionToDeclaration) {
      return selection;
    }

    return this.next
      ? selection.extendEndToStartOf(Selection.fromAST(this.next.loc))
      : selection.extendStartToEndOf(Selection.fromAST(this.previous.loc));
  }
}

class InlinableObjectPattern extends CompositeInlinable {
  private initName: string;
  private property: ast.SelectableObjectProperty;
  private previous: ast.SelectableObjectProperty | undefined;
  private next: ast.SelectableObjectProperty | undefined;
  private hasRestSibling: boolean;

  constructor(
    child: InlinableCode,
    initName: string,
    property: ast.SelectableObjectProperty,
    hasRestSibling: boolean,
    previous?: ast.Node | null,
    next?: ast.Node | null
  ) {
    super(child);
    this.initName = initName;
    this.property = property;
    this.hasRestSibling = hasRestSibling;

    if (previous && ast.isSelectableObjectProperty(previous)) {
      this.previous = previous;
    }

    if (next && ast.isSelectableObjectProperty(next)) {
      this.next = next;
    }
  }

  get shouldExtendSelectionToDeclaration(): boolean {
    if (!super.shouldExtendSelectionToDeclaration) return false;

    if (this.hasRestSibling) {
      return false;
    }

    return !this.next && !this.previous;
  }

  get codeToRemoveSelection(): Selection {
    if (!super.shouldExtendSelectionToDeclaration) {
      return super.codeToRemoveSelection;
    }

    if (this.hasRestSibling) {
      const valueSelection = Selection.fromAST(this.property.value.loc);
      const keySelection = Selection.fromAST(this.property.key.loc);
      const NO_SELECTION = Selection.cursorAt(0, 0);

      return ast.isObjectPattern(this.property.value)
        ? valueSelection.extendStartToEndOf(keySelection)
        : NO_SELECTION;
    }

    const selection = Selection.fromAST(this.property.loc);

    if (this.next) {
      return selection.extendEndToStartOf(Selection.fromAST(this.next.loc));
    }

    if (this.previous) {
      return selection.extendStartToEndOf(Selection.fromAST(this.previous.loc));
    }

    return selection;
  }

  updateIdentifiersWith(inlinedCode: Code): Modification[] {
    return super.updateIdentifiersWith(
      this.prependObjectValueWithInitName(inlinedCode)
    );
  }

  private prependObjectValueWithInitName(code: Code): Code {
    // If destructured variable was renamed, `code` would be `userId: id`.
    // In that case, we only want to retrieve the `userId` part
    const objectValue = code.split(":")[0];

    const OBJECT_SEPARATOR = ".";
    const parts = objectValue.split(OBJECT_SEPARATOR);
    const lastPart = parts.pop();

    return [...parts, this.initName, lastPart].join(OBJECT_SEPARATOR);
  }
}

class InlinableArrayPattern extends CompositeInlinable {
  private index: number;
  private element: ast.SelectableNode;
  private previous: ast.SelectableNode | undefined;
  private next: ast.SelectableNode | undefined;

  constructor(
    child: InlinableCode,
    index: number,
    element: ast.SelectableNode,
    previous?: ast.Node | null,
    next?: ast.Node | null
  ) {
    super(child);
    this.index = index;
    this.element = element;

    if (previous && ast.isSelectableNode(previous)) {
      this.previous = previous;
    }

    if (next && ast.isSelectableNode(next)) {
      this.next = next;
    }
  }

  get shouldExtendSelectionToDeclaration(): boolean {
    if (!super.shouldExtendSelectionToDeclaration) return false;

    return !this.next && !this.previous;
  }

  get codeToRemoveSelection(): Selection {
    if (!super.shouldExtendSelectionToDeclaration) {
      return super.codeToRemoveSelection;
    }

    const selection = Selection.fromAST(this.element.loc);

    if (this.previous && !this.next) {
      return selection.extendStartToEndOf(Selection.fromAST(this.previous.loc));
    }

    return selection;
  }

  updateIdentifiersWith(inlinedCode: Code): Modification[] {
    return super.updateIdentifiersWith(`${inlinedCode}[${this.index}]`);
  }
}

class InlinableTopLevelPattern extends CompositeInlinable {
  private loc: ast.SourceLocation;

  constructor(child: InlinableCode, loc: ast.SourceLocation) {
    super(child);
    this.loc = loc;
  }

  get codeToRemoveSelection(): Selection {
    return super.shouldExtendSelectionToDeclaration
      ? Selection.fromAST(this.loc)
      : super.codeToRemoveSelection;
  }
}
