import { Editor, ErrorReason, Code } from "../../../editor/editor";
import { Selection } from "../../../editor/selection";
import { InMemoryEditor } from "../../../editor/adapters/in-memory-editor";
import { testEach } from "../../../tests-helpers";

import { addBracesToJsxAttribute } from "./add-braces-to-jsx-attribute";

describe("Add Braces To Jsx Attribute", () => {
  let showErrorMessage: Editor["showError"];

  beforeEach(() => {
    showErrorMessage = jest.fn();
  });

  testEach<{ code: Code; selection?: Selection; expected: Code }>(
    "should add braces to jsx attribute",
    [
      // TODO: write successful test cases here
    ],
    async ({ code, selection = Selection.cursorAt(0, 0), expected }) => {
      const result = await doAddBracesToJsxAttribute(code, selection);

      expect(result).toBe(expected);
    }
  );

  it("should show an error message if refactoring can't be made", async () => {
    const code = `// This is a comment, can't be refactored`;
    const selection = Selection.cursorAt(0, 0);

    await doAddBracesToJsxAttribute(code, selection);

    expect(showErrorMessage).toBeCalledWith(
      ErrorReason.DidNotFoundJsxAttributeToAddBracesTo
    );
  });

  async function doAddBracesToJsxAttribute(
    code: Code,
    selection: Selection
  ): Promise<Code> {
    const editor = new InMemoryEditor(code);
    editor.showError = showErrorMessage;
    await addBracesToJsxAttribute(code, selection, editor);
    return editor.code;
  }
});
