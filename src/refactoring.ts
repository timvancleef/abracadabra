export { Refactoring };

// String values must match `command` fields in `package.json`
enum Refactoring {
  RenameSymbol = "abracadabra.renameSymbol",
  ExtractVariable = "abracadabra.extractVariable",
  InlineVariable = "abracadabra.inlineVariable",
  NegateExpression = "abracadabra.negateExpression",
  RemoveRedundantElse = "abracadabra.removeRedundantElse",
  FlipIfElse = "abracadabra.flipIfElse",
  FlipTernary = "abracadabra.flipTernary",
  ConvertIfElseToTernary = "abracadabra.convertIfElseToTernary"
}
