// ============================================================
// src/repl/transform.ts — AST cell transformer
//
// Public entry: `@ghostflyby/aves/repl/transform`
// Functional system: turn a cell's ESM source into a
// `return (async () => {...})()` body that runs in a persistent
// scope (declarations → `this.*`, imports → await import, reference
// rewriting, auto-return; `this` is the injected scope binding — see
// the `transform` JSDoc).
//
// Uses acorn (parse) + astring (generate).
// Three transformations:
//   1. Import declarations → this.x = (await import("spec")).x
//   2. Variable/function declarations → this.x = ...
//   3. Reference rewrite: declared names → this.x
// ============================================================

import * as acorn from "acorn";
import { generate } from "astring";

type EstreeNode = Record<string, unknown> & {
  type: string;
  start?: number;
  end?: number;
};

/**
 * Transform a cell's ESM source so it runs in a persistent scope.
 *
 * INPUT — `code` must be valid ESM JavaScript: `import`/`export` statements
 * are allowed, but TypeScript must already be stripped (esbuild
 * `loader: "ts"`, `format: "esm"` is the canonical pipeline). `declaredNames`
 * carries names declared by earlier cells; pass the **same set** across cells
 * so prior declarations keep resolving.
 *
 * OUTPUT — a function *body*, not a complete program:
 *
 *   `return (async () => { <rewritten statements> })();`
 *
 * intended for `new AsyncFunction(body)`. Declarations become
 * `this.x = ...` assignments, imports become `this.x = (await import(...)).x`,
 * references to declared names become `this.x` (closure-aware), and the last
 * expression is auto-returned. The async wrapper makes top-level `await`
 * legal.
 *
 * SCOPE BINDING — the persistent scope is injected via **`this`**, not a
 * parameter name: call the function with `fn.call(scopeObject)` (the arrow
 * inside captures `this`). Because `this` is an implicit binding, user code
 * may freely declare or reference identifiers named `scope` — there is no
 * reserved identifier. Two consequences: (1) the body is non-strict, so
 * calling without `.call(...)` makes `this` the global object and silently
 * writes to it — always call with `.call(scope)`; (2) a user's *own* top-level
 * `this` (e.g. `return this`) resolves to the injected scope object instead
 * of the usual `undefined`/global, which is an intentional, documented
 * deviation.
 */
export function transform(
  code: string,
  declaredNames: Set<string>,
): string {
  const ast = acorn.parse(code, {
    ecmaVersion: "latest",
    sourceType: "module",
  }) as unknown as { type: string; body: EstreeNode[] };

  // Remember whether the last statement is an expression before
  // transformAst mutates the body — used for auto-return below.
  const originalLast = ast.body[ast.body.length - 1];
  const isExpressionEval = originalLast?.type === "ExpressionStatement";

  transformAst(ast, declaredNames);
  const generated = generate(ast, { comments: true });
  let rewritten = rewriteReferences(generated, declaredNames);

  // Auto-return the last expression so code like "1+1" or "x" yields
  // a data value instead of undefined.  We reparse the *already-
  // rewritten* body (avoiding acorn "return outside function" errors
  // at module level during rewriteReferences) and convert the last
  // ExpressionStatement to a ReturnStatement.
  if (isExpressionEval) {
    const rewrittenAst = acorn.parse(rewritten, {
      ecmaVersion: "latest",
      sourceType: "module",
    }) as unknown as { type: string; body: EstreeNode[] };
    const lastStmt = rewrittenAst.body[rewrittenAst.body.length - 1];
    if (lastStmt && lastStmt.type === "ExpressionStatement") {
      const expr =
        ((lastStmt as unknown) as { expression: EstreeNode }).expression;
      rewrittenAst.body[rewrittenAst.body.length - 1] = {
        type: "ReturnStatement",
        argument: expr,
      } as unknown as EstreeNode;
      rewritten = generate(rewrittenAst, { comments: true });
    }
  }

  return `return (async () => { ${rewritten} })();`;
}

function transformAst(
  ast: { body: EstreeNode[] },
  declaredNames: Set<string>,
): void {
  const newBody: EstreeNode[] = [];
  for (const stmt of ast.body) {
    const result = transformStatement(stmt, declaredNames);
    if (result) {
      if (Array.isArray(result)) newBody.push(...result);
      else newBody.push(result);
    }
  }
  ast.body = newBody;
}

function transformStatement(
  stmt: EstreeNode,
  declaredNames: Set<string>,
): EstreeNode | EstreeNode[] | null {
  switch (stmt.type) {
    case "ImportDeclaration":
      return transformImport(stmt);
    case "ExportNamedDeclaration":
    case "ExportDefaultDeclaration":
    case "ExportAllDeclaration":
      return null;
    case "VariableDeclaration":
      return transformVariableDecl(stmt, declaredNames);
    case "FunctionDeclaration":
      return transformFuncDecl(stmt, declaredNames);
    case "ClassDeclaration":
      return transformClassDecl(stmt, declaredNames);
    default:
      return stmt;
  }
}

function transformImport(node: EstreeNode): EstreeNode[] {
  const specifiers = node.specifiers as unknown as Array<{
    type: string;
    imported?: { name: string };
    local: { name: string };
  }>;
  const source = (node.source as unknown as { value: string }).value;
  const stmts: EstreeNode[] = [];

  if (specifiers.length === 0) {
    stmts.push(es(acall(imp(source))));
    return stmts;
  }

  for (const spec of specifiers) {
    const localName = spec.local.name;
    let right: EstreeNode;
    switch (spec.type) {
      case "ImportDefaultSpecifier":
        right = mem(acall(imp(source)), "default");
        break;
      case "ImportNamespaceSpecifier":
        right = acall(imp(source));
        break;
      case "ImportSpecifier": {
        const importedName = spec.imported?.name ?? localName;
        right = mem(acall(imp(source)), importedName);
        break;
      }
      default:
        continue;
    }
    stmts.push(es(assign(scopeMem(localName), right)));
  }
  return stmts;
}

function transformVariableDecl(
  node: EstreeNode,
  declaredNames: Set<string>,
): EstreeNode[] {
  const decls = node.declarations as unknown as Array<{
    type: string;
    id: EstreeNode;
    init: EstreeNode | null;
    start: number;
  }>;
  const stmts: EstreeNode[] = [];

  for (const decl of decls) {
    if (decl.id.type === "Identifier") {
      const name = (decl.id as unknown as { name: string }).name;
      declaredNames.add(name);
      stmts.push(es(assign(
        scopeMem(name),
        decl.init ?? id("undefined"),
      )));
    } else {
      collectNames(decl.id, declaredNames);
      if (decl.init) {
        const tempName = `__aves_tmp_${decl.start}`;
        declaredNames.add(tempName);
        stmts.push(es(assign(scopeMem(tempName), decl.init)));
        genDestructure(decl.id, tempName, stmts);
      }
    }
  }
  return stmts;
}

function collectNames(node: EstreeNode, names: Set<string>): void {
  if (node.type === "Identifier") {
    names.add((node as unknown as { name: string }).name);
  } else if (node.type === "ObjectPattern") {
    for (
      const prop of (
        node.properties as unknown as Array<{ value: EstreeNode }>
      ) ?? []
    ) {
      collectNames(prop.value, names);
    }
  } else if (node.type === "ArrayPattern") {
    for (
      const elem of (
        node.elements as unknown as Array<EstreeNode | null>
      ) ?? []
    ) {
      if (elem) collectNames(elem, names);
    }
  } else if (node.type === "AssignmentPattern") {
    collectNames(
      (node as unknown as { left: EstreeNode }).left,
      names,
    );
  } else if (node.type === "RestElement") {
    collectNames(
      (node as unknown as { argument: EstreeNode }).argument,
      names,
    );
  }
}

function genDestructure(
  node: EstreeNode,
  tempName: string,
  stmts: EstreeNode[],
): void {
  const w = (
    n: EstreeNode,
    accessor: EstreeNode,
  ): void => {
    if (n.type === "Identifier") {
      const name = (n as unknown as { name: string }).name;
      stmts.push(es(assign(scopeMem(name), accessor)));
    } else if (n.type === "ObjectPattern") {
      for (
        const prop of (
          n.properties as unknown as Array<
            { key: { name: string }; value: EstreeNode }
          >
        ) ?? []
      ) {
        w(prop.value, mem(accessor, prop.key.name));
      }
    } else if (n.type === "ArrayPattern") {
      const elems = (n.elements as unknown as Array<EstreeNode | null>) ?? [];
      for (let i = 0; i < elems.length; i++) {
        if (elems[i]) w(elems[i]!, mem(accessor, String(i), true));
      }
    } else if (n.type === "AssignmentPattern") {
      const ap = n as unknown as { left: EstreeNode; right: EstreeNode };
      if (ap.left.type === "Identifier") {
        const name = (ap.left as unknown as { name: string }).name;
        stmts.push(es(assign(scopeMem(name), lor(accessor, ap.right))));
      } else {
        w(ap.left, accessor);
      }
    } else if (n.type === "RestElement") {
      const re = n as unknown as { argument: EstreeNode };
      if (re.argument.type === "Identifier") {
        const name = (re.argument as unknown as { name: string }).name;
        stmts.push(es(assign(scopeMem(name), accessor)));
      }
    }
  };
  w(node, scopeMem(tempName));
}

function transformFuncDecl(
  node: EstreeNode,
  declaredNames: Set<string>,
): EstreeNode {
  const fd = node as unknown as {
    id: { name: string } | null;
    params: EstreeNode[];
    body: EstreeNode;
    async: boolean;
    generator: boolean;
  };
  if (!fd.id) return node;
  const name = fd.id.name;
  declaredNames.add(name);

  const funcExpr = {
    type: "FunctionExpression",
    id: { type: "Identifier", name },
    params: fd.params,
    body: fd.body,
    async: fd.async,
    generator: fd.generator,
  };

  return es(assign(scopeMem(name), funcExpr as unknown as EstreeNode));
}

function transformClassDecl(
  node: EstreeNode,
  declaredNames: Set<string>,
): EstreeNode {
  const cd = node as unknown as {
    id: { name: string } | null;
    superClass: EstreeNode | null;
    body: EstreeNode;
  };
  if (!cd.id) return node;
  const name = cd.id.name;
  declaredNames.add(name);

  const classExpr = {
    type: "ClassExpression",
    id: { type: "Identifier", name },
    superClass: cd.superClass,
    body: cd.body,
  };

  return es(assign(scopeMem(name), classExpr as unknown as EstreeNode));
}

// ============================================================
// Phase 2: Reference rewrite — uses local-scope stack to
// handle closures correctly
// ============================================================

/**
 * Rewrite identifier references to `this.<name>` for every name in
 * `declaredNames`, skipping locals shadowed inside functions/blocks and
 * leaving `this.x` accesses untouched (`this` is the injected scope binding
 * and cannot be shadowed by an identifier — see the `transform` JSDoc for the
 * binding contract). Used internally by `transform` as its reference phase;
 * exported for hosts that assemble their own pipeline.
 *
 * INPUT — code whose declarations have **already been rewritten to
 * `this.x = ...` assignments** (e.g. `transform`'s phase-1 output). Feeding
 * raw source such as `const x = 1; x + 1` leaves the declaration local while
 * rewriting the reference to `this.x`, so the reference will not resolve.
 *
 * OUTPUT — the same statement list as the input, with only identifier
 * references replaced by `this.<name>`: no declaration rewriting, no
 * auto-return, no async-IIFE wrapper. An empty `declaredNames` returns the
 * input unchanged.
 */
export function rewriteReferences(
  code: string,
  declaredNames: Set<string>,
): string {
  if (declaredNames.size === 0) return code;

  const ast = acorn.parse(code, {
    ecmaVersion: "latest",
    sourceType: "module",
  }) as unknown as { body: EstreeNode[] };

  const reps: Array<{ s: number; e: number; t: string }> = [];
  walkRefs(ast.body, declaredNames, [], reps, false);
  reps.sort((a, b) => b.s - a.s);

  let result = code;
  for (const r of reps) {
    result = result.slice(0, r.s) + r.t + result.slice(r.e);
  }
  return result;
}

type ScopeStack = Set<string>[];

function topScope(ss: ScopeStack): Set<string> | null {
  return ss.length > 0 ? ss[ss.length - 1] : null;
}

function walkRefs(
  nodes: EstreeNode[],
  names: Set<string>,
  localScopes: ScopeStack,
  reps: Array<{ s: number; e: number; t: string }>,
  isDecl: boolean,
): void {
  for (const n of nodes) walkRef(n, names, localScopes, reps, isDecl);
}

function addParamsToScope(params: EstreeNode[], scopes: ScopeStack): void {
  const scope = scopes[scopes.length - 1];
  function add(node: EstreeNode): void {
    if (node.type === "Identifier") {
      scope.add((node as unknown as { name: string }).name);
    } else if (node.type === "ObjectPattern") {
      for (
        const prop
          of (node as unknown as { properties: Array<{ value: EstreeNode }> })
            .properties
      ) {
        add(prop.value);
      }
    } else if (node.type === "ArrayPattern") {
      for (
        const elem
          of (node as unknown as { elements: Array<EstreeNode | null> })
            .elements
      ) {
        if (elem) add(elem);
      }
    } else if (node.type === "AssignmentPattern") {
      add((node as unknown as { left: EstreeNode }).left);
    } else if (node.type === "RestElement") {
      add((node as unknown as { argument: EstreeNode }).argument);
    }
  }
  for (const p of params) add(p);
}

function walkRef(
  node: EstreeNode,
  names: Set<string>,
  localScopes: ScopeStack,
  reps: Array<{ s: number; e: number; t: string }>,
  isDecl: boolean,
): void {
  if (!node || typeof node !== "object") return;

  const scoped = [
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
    "ClassExpression",
  ];

  if (scoped.includes(node.type)) {
    localScopes.push(new Set());
    if (node.type === "FunctionDeclaration") {
      const fd = node as unknown as {
        params: EstreeNode[];
        body: EstreeNode;
      };
      addParamsToScope(fd.params, localScopes);
      for (const p of fd.params) walkRef(p, names, localScopes, reps, true);
      walkFnBody(fd.body, names, localScopes, reps);
    } else if (node.type === "FunctionExpression") {
      const fe = node as unknown as {
        id: EstreeNode | null;
        params: EstreeNode[];
        body: EstreeNode;
      };
      addParamsToScope(fe.params, localScopes);
      if (fe.id) walkRef(fe.id, names, localScopes, reps, true);
      for (const p of fe.params) walkRef(p, names, localScopes, reps, true);
      walkFnBody(fe.body, names, localScopes, reps);
    } else if (node.type === "ArrowFunctionExpression") {
      const a = node as unknown as {
        params: EstreeNode[];
        body: EstreeNode;
      };
      addParamsToScope(a.params, localScopes);
      for (const p of a.params) walkRef(p, names, localScopes, reps, true);
      walkFnBody(a.body, names, localScopes, reps);
    } else if (node.type === "ClassExpression") {
      const ce = node as unknown as {
        id: EstreeNode | null;
        superClass: EstreeNode | null;
        body: EstreeNode;
      };
      // The class expression's own name is a binding inside the class body
      // (and its own declaration), not a reference to the outer scope.
      if (ce.id) {
        const ts = localScopes[localScopes.length - 1];
        if (ce.id.type === "Identifier") {
          ts.add((ce.id as unknown as { name: string }).name);
        }
        walkRef(ce.id, names, localScopes, reps, true);
      }
      if (ce.superClass) {
        walkRef(ce.superClass, names, localScopes, reps, false);
      }
      walkRef(ce.body, names, localScopes, reps, false);
    }
    localScopes.pop();
    return;
  }

  if (node.type === "BlockStatement") {
    const body = (node as unknown as { body: EstreeNode[] }).body;
    localScopes.push(new Set());
    walkRefs(body, names, localScopes, reps, false);
    localScopes.pop();
    return;
  }

  if (node.type === "MemberExpression") {
    const me = node as unknown as {
      object: EstreeNode;
      property: EstreeNode;
      computed: boolean;
    };
    if (me.object.type === "ThisExpression") {
      // `this.x` — the injected scope binding (see the transform JSDoc).
      // The object is a ThisExpression, never an Identifier, so it cannot be
      // shadowed or re-written; just rewrite the property reference.
      if (me.computed) {
        walkRef(me.property, names, localScopes, reps, false);
      }
      return;
    }
    walkRef(me.object, names, localScopes, reps, false);
    if (me.computed) {
      walkRef(me.property, names, localScopes, reps, false);
    }
    return;
  }

  if (node.type === "AssignmentExpression") {
    const ae = node as unknown as {
      left: EstreeNode;
      right: EstreeNode;
      operator: string;
    };
    if (ae.left.type === "MemberExpression") {
      const me = ae.left as unknown as {
        object: EstreeNode;
        property: EstreeNode;
        computed: boolean;
      };
      if (me.object.type === "ThisExpression") {
        // `this.x = ...` (the injected scope binding): never re-write, just
        // descend into the computed property and the right-hand side.
        if (me.computed) {
          walkRef(me.property, names, localScopes, reps, false);
        }
        walkRef(ae.right, names, localScopes, reps, false);
        return;
      }
    }
    if (ae.left.type === "Identifier" && ae.operator === "=") {
      walkRef(ae.left, names, localScopes, reps, false);
      walkRef(ae.right, names, localScopes, reps, false);
      return;
    }
  }

  if (node.type === "VariableDeclarator") {
    const vd = node as unknown as { id: EstreeNode; init: EstreeNode | null };
    const ts = topScope(localScopes);
    if (ts && vd.id.type === "Identifier") {
      ts.add((vd.id as unknown as { name: string }).name);
    }
    walkRef(vd.id, names, localScopes, reps, true);
    if (vd.init) walkRef(vd.init, names, localScopes, reps, false);
    return;
  }

  if (node.type === "Property") {
    const prop = node as unknown as {
      key: EstreeNode;
      value: EstreeNode;
      computed: boolean;
    };
    if (prop.computed) {
      walkRef(prop.key, names, localScopes, reps, false);
    }
    walkRef(prop.value, names, localScopes, reps, false);
    return;
  }

  if (node.type === "Identifier" && !isDecl) {
    const name = (node as unknown as { name: string }).name;
    const isLocal = localScopes.some((s) => s.has(name));
    if (names.has(name) && !isLocal) {
      // Rewrite the reference to the injected scope binding (`this`).
      reps.push({ s: node.start!, e: node.end!, t: `this.${name}` });
      return;
    }
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && "type" in child) {
          walkRef(child as EstreeNode, names, localScopes, reps, false);
        }
      }
    } else if (value && typeof value === "object" && "type" in value) {
      walkRef(value as EstreeNode, names, localScopes, reps, false);
    }
  }
}

function walkFnBody(
  body: EstreeNode,
  names: Set<string>,
  localScopes: ScopeStack,
  reps: Array<{ s: number; e: number; t: string }>,
): void {
  if (body.type === "BlockStatement") {
    walkRefs(
      (body as unknown as { body: EstreeNode[] }).body,
      names,
      localScopes,
      reps,
      false,
    );
  } else {
    walkRef(body, names, localScopes, reps, false);
  }
}

function id(name: string): EstreeNode {
  return { type: "Identifier", name };
}

function scopeMem(name: string): EstreeNode {
  return {
    type: "MemberExpression",
    object: { type: "ThisExpression" },
    property: { type: "Identifier", name },
    computed: false,
    optional: false,
  };
}

function mem(obj: EstreeNode, prop: string, computed = false): EstreeNode {
  return {
    type: "MemberExpression",
    object: obj,
    property: computed
      ? { type: "Literal", value: Number(prop), raw: prop }
      : { type: "Identifier", name: prop },
    computed,
    optional: false,
  };
}

function imp(source: string): EstreeNode {
  return {
    type: "ImportExpression",
    source: { type: "Literal", value: source, raw: JSON.stringify(source) },
  };
}

function acall(arg: EstreeNode): EstreeNode {
  return { type: "AwaitExpression", argument: arg };
}

function assign(left: EstreeNode, right: EstreeNode): EstreeNode {
  return { type: "AssignmentExpression", operator: "=", left, right };
}

function es(expr: EstreeNode): EstreeNode {
  return { type: "ExpressionStatement", expression: expr };
}

function lor(left: EstreeNode, right: EstreeNode): EstreeNode {
  return { type: "LogicalExpression", operator: "??", left, right };
}
