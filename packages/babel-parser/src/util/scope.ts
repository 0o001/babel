import { ScopeFlag, BindingFlag, type BindingTypes } from "./scopeflags";
import type { Position } from "./location";
import type * as N from "../types";
import { Errors } from "../parse-error";
import type Tokenizer from "../tokenizer";

// Start an AST node, attaching a start offset.
export class Scope {
  declare flags: ScopeFlag;
  // A set of var-declared names in the current lexical scope
  var: Set<string> = new Set();
  // A set of lexically-declared names in the current lexical scope
  lexical: Set<string> = new Set();
  // A set of lexically-declared FunctionDeclaration names in the current lexical scope
  functions: Set<string> = new Set();

  constructor(flags: ScopeFlag) {
    this.flags = flags;
  }
}

// The functions in this module keep track of declared variables in the
// current scope in order to detect duplicate variable names.
export default class ScopeHandler<IScope extends Scope = Scope> {
  parser: Tokenizer;
  scopeStack: Array<IScope> = [];
  inModule: boolean;
  undefinedExports: Map<string, Position> = new Map();

  constructor(parser: Tokenizer, inModule: boolean) {
    this.parser = parser;
    this.inModule = inModule;
  }

  get inTopLevel() {
    return (this.currentScope().flags & ScopeFlag.PROGRAM) > 0;
  }
  get inFunction() {
    return (this.currentVarScopeFlags() & ScopeFlag.FUNCTION) > 0;
  }
  get allowSuper() {
    return (this.currentThisScopeFlags() & ScopeFlag.SUPER) > 0;
  }
  get allowDirectSuper() {
    return (this.currentThisScopeFlags() & ScopeFlag.DIRECT_SUPER) > 0;
  }
  get inClass() {
    return (this.currentThisScopeFlags() & ScopeFlag.CLASS) > 0;
  }
  get inClassAndNotInNonArrowFunction() {
    const flags = this.currentThisScopeFlags();
    return (flags & ScopeFlag.CLASS) > 0 && (flags & ScopeFlag.FUNCTION) === 0;
  }
  get inStaticBlock() {
    for (let i = this.scopeStack.length - 1; ; i--) {
      const { flags } = this.scopeStack[i];
      if (flags & ScopeFlag.STATIC_BLOCK) {
        return true;
      }
      if (flags & (ScopeFlag.VAR | ScopeFlag.CLASS)) {
        // function body, module body, class property initializers
        return false;
      }
    }
  }
  get inNonArrowFunction() {
    return (this.currentThisScopeFlags() & ScopeFlag.FUNCTION) > 0;
  }
  get treatFunctionsAsVar() {
    return this.treatFunctionsAsVarInScope(this.currentScope());
  }

  createScope(flags: ScopeFlag): Scope {
    return new Scope(flags);
  }

  enter(flags: ScopeFlag) {
    /*:: +createScope: (flags:ScopeFlag) => IScope; */
    // @ts-expect-error This method will be overwritten by subclasses
    this.scopeStack.push(this.createScope(flags));
  }

  exit(): ScopeFlag {
    const scope = this.scopeStack.pop();
    return scope.flags;
  }

  // The spec says:
  // > At the top level of a function, or script, function declarations are
  // > treated like var declarations rather than like lexical declarations.
  treatFunctionsAsVarInScope(scope: IScope): boolean {
    return !!(
      scope.flags & (ScopeFlag.FUNCTION | ScopeFlag.STATIC_BLOCK) ||
      (!this.parser.inModule && scope.flags & ScopeFlag.PROGRAM)
    );
  }

  declareName(name: string, bindingType: BindingTypes, loc: Position) {
    let scope = this.currentScope();
    if (
      bindingType & BindingFlag.SCOPE_LEXICAL ||
      bindingType & BindingFlag.SCOPE_FUNCTION
    ) {
      this.checkRedeclarationInScope(scope, name, bindingType, loc);

      if (bindingType & BindingFlag.SCOPE_FUNCTION) {
        scope.functions.add(name);
      } else {
        scope.lexical.add(name);
      }

      if (bindingType & BindingFlag.SCOPE_LEXICAL) {
        this.maybeExportDefined(scope, name);
      }
    } else if (bindingType & BindingFlag.SCOPE_VAR) {
      for (let i = this.scopeStack.length - 1; i >= 0; --i) {
        scope = this.scopeStack[i];
        this.checkRedeclarationInScope(scope, name, bindingType, loc);
        scope.var.add(name);
        this.maybeExportDefined(scope, name);

        if (scope.flags & ScopeFlag.VAR) break;
      }
    }
    if (this.parser.inModule && scope.flags & ScopeFlag.PROGRAM) {
      this.undefinedExports.delete(name);
    }
  }

  maybeExportDefined(scope: IScope, name: string) {
    if (this.parser.inModule && scope.flags & ScopeFlag.PROGRAM) {
      this.undefinedExports.delete(name);
    }
  }

  checkRedeclarationInScope(
    scope: IScope,
    name: string,
    bindingType: BindingTypes,
    loc: Position,
  ) {
    if (this.isRedeclaredInScope(scope, name, bindingType)) {
      this.parser.raise(Errors.VarRedeclaration, {
        at: loc,
        identifierName: name,
      });
    }
  }

  isRedeclaredInScope(
    scope: IScope,
    name: string,
    bindingType: BindingTypes,
  ): boolean {
    if (!(bindingType & BindingFlag.KIND_VALUE)) return false;

    if (bindingType & BindingFlag.SCOPE_LEXICAL) {
      return (
        scope.lexical.has(name) ||
        scope.functions.has(name) ||
        scope.var.has(name)
      );
    }

    if (bindingType & BindingFlag.SCOPE_FUNCTION) {
      return (
        scope.lexical.has(name) ||
        (!this.treatFunctionsAsVarInScope(scope) && scope.var.has(name))
      );
    }

    return (
      (scope.lexical.has(name) &&
        // Annex B.3.4
        // https://tc39.es/ecma262/#sec-variablestatements-in-catch-blocks
        !(
          scope.flags & ScopeFlag.SIMPLE_CATCH &&
          scope.lexical.values().next().value === name
        )) ||
      (!this.treatFunctionsAsVarInScope(scope) && scope.functions.has(name))
    );
  }

  checkLocalExport(id: N.Identifier) {
    const { name } = id;
    const topLevelScope = this.scopeStack[0];
    if (
      !topLevelScope.lexical.has(name) &&
      !topLevelScope.var.has(name) &&
      // In strict mode, scope.functions will always be empty.
      // Modules are strict by default, but the `scriptMode` option
      // can overwrite this behavior.
      !topLevelScope.functions.has(name)
    ) {
      this.undefinedExports.set(name, id.loc.start);
    }
  }

  currentScope(): IScope {
    return this.scopeStack[this.scopeStack.length - 1];
  }

  currentVarScopeFlags(): ScopeFlag {
    for (let i = this.scopeStack.length - 1; ; i--) {
      const { flags } = this.scopeStack[i];
      if (flags & ScopeFlag.VAR) {
        return flags;
      }
    }
  }

  // Could be useful for `arguments`, `this`, `new.target`, `super()`, `super.property`, and `super[property]`.
  currentThisScopeFlags(): ScopeFlag {
    for (let i = this.scopeStack.length - 1; ; i--) {
      const { flags } = this.scopeStack[i];
      if (
        flags & (ScopeFlag.VAR | ScopeFlag.CLASS) &&
        !(flags & ScopeFlag.ARROW)
      ) {
        return flags;
      }
    }
  }
}
