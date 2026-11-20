/**
 * Usage example: from DSL text to a resolved model.
 *   npm run example        (from packages/core)
 */
import { indexWorkspace, load, parse, resolve } from "../src/index.ts";

const source = `
workspace "Online Shop" "Orders and payments" {

    !identifiers hierarchical

    model {
        customer = person "Customer" "Buys things"

        shop = softwareSystem "Shop" {
            web = container "Web App" "Serves the storefront" "React"
            api = container "API" "Business logic" "Java"
            db  = container "Database" "Stores orders" "PostgreSQL" "Database"

            shop.web -> shop.api "Calls" "JSON/HTTPS"
            shop.api -> shop.db "Reads from and writes to" "JDBC"
        }

        payments = softwareSystem "Payment Provider" "External"

        customer -> shop.web "Browses and orders"
        shop.api -> payments "Takes payment" "HTTPS"
    }

    views {
        systemContext shop "context" {
            include *
            autoLayout lr
        }

        container shop "containers" {
            include *
            exclude "element.tag==Database"
        }

        dynamic shop "checkout" "Placing an order" {
            customer -> shop.web "Submits the order"
            shop.web -> shop.api
            shop.api -> payments
        }

        styles {
            element "Database" {
                shape Cylinder
            }
        }
    }
}
`;

// 1. One call: parse + resolve. Never throws; always returns a workspace.
const result = load(source);

// 2. Diagnostics: errors, warnings, each with an exact source range (0-based line/column).
for (const d of result.diagnostics) {
  console.log(`${d.severity} ${d.range.start.line + 1}:${d.range.start.column + 1} [${d.code}] ${d.message}`);
}
console.log(`ok: ${result.ok}${result.firstError ? ` (first error: ${result.firstError.message})` : ""}\n`);

// 3. The resolved workspace is plain JSON: elements, relationships and views refer to each other by id.
const ws = result.workspace;
console.log(`${ws.name}: ${ws.model.elements.length} elements, ${ws.model.relationships.length} relationships, ${ws.views.length} views\n`);

// 4. indexWorkspace gives fast lookups without changing the data.
const index = indexWorkspace(ws);
const api = index.byIdentifier("shop.api");
if (api && "type" in api) {
  console.log(`${api.name} (${api.type}) tags: ${api.tags.join(", ")}`);
  for (const r of index.outgoing(api.id)) {
    const to = index.element(r.destinationId)!;
    console.log(`  -> ${to.name}: "${r.description}"${r.technology ? ` [${r.technology}]` : ""}${r.linkedRelationshipId ? " (implied)" : ""}`);
  }
}

// 5. Views arrive with their contents already computed (include/exclude/wildcards evaluated).
for (const view of ws.views) {
  const elements = index.viewElements(view).map((e) => e.name);
  console.log(`\nview "${view.key}" (${view.type}): ${elements.join(", ")}`);
  if (view.steps) {
    for (const s of view.steps) {
      const r = index.relationship(s.relationshipId)!;
      const [a, b] = [index.element(r.sourceId)!.name, index.element(r.destinationId)!.name];
      console.log(`  ${s.order}. ${s.reversed ? `${b} -> ${a}` : `${a} -> ${b}`} ${s.description ?? r.description}`);
    }
  } else {
    for (const r of index.viewRelationships(view)) {
      console.log(`  ${index.element(r.sourceId)!.name} -> ${index.element(r.destinationId)!.name}: ${r.description}`);
    }
  }
}

// 6. Ship it anywhere: it is plain data (webview postMessage, a file, an exporter).
const json = JSON.stringify(ws);
console.log(`\nserialized: ${json.length} bytes of JSON`);

// The two stages can also be used separately, e.g. an editor wants the syntax tree for its outline
// and the resolver for semantic checks.
const syntax = parse(source);
const resolved = resolve(syntax.root);
console.log(`syntax statements at top level: ${syntax.root.children.length}; resolver diagnostics: ${resolved.diagnostics.length}`);
