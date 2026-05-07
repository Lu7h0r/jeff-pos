import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";

interface ParsedRow {
  rawLine: string;
  name: string;
  normalizedName: string;
  price: number;
  cost: number;
  quantity: number;
  category: string;
  issues: string[];
}

interface ImportStats {
  parsed: number;
  skipped: number;
  createdProducts: number;
  updatedProducts: number;
  createdBalances: number;
  updatedBalances: number;
  omittedBalances: number;
}

const SOURCE_MD = process.env.TREINTA_MD_PATH ?? "../../treinta_inventario.md";
const OUTPUT_DIR = "./data/imports";
const OUTPUT_JSON = `${OUTPUT_DIR}/treinta_inventory.normalized.json`;
const OUTPUT_CSV = `${OUTPUT_DIR}/treinta_inventory.normalized.csv`;

const TARGET_BUSINESS_SLUG = process.env.TREINTA_BUSINESS_SLUG ?? "jeff";
const TARGET_LOCATION_SLUG = process.env.TREINTA_LOCATION_SLUG ?? "amparo";
const DRY_RUN = process.argv.includes("--dry-run");
const NORMALIZE_ONLY = process.argv.includes("--normalize-only");

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleCase(value: string): string {
  return value
    .split(" ")
    .filter(Boolean)
    .map((token) => token[0]?.toUpperCase() + token.slice(1).toLowerCase())
    .join(" ");
}

function parseCopAmount(raw: string): number {
  const digits = raw.replace(/[^0-9-]/g, "");
  if (digits === "" || digits === "-") return 0;
  return Number.parseInt(digits, 10);
}

function parseQuantity(raw: string): number {
  const digits = raw.replace(/[^0-9-]/g, "");
  if (digits === "" || digits === "-") return 0;
  return Number.parseInt(digits, 10);
}

function pickCategory(name: string, categoryCandidates: string[]): string {
  const normalizedName = normalizeText(name);
  const normalizedCandidates = categoryCandidates.map((candidate) => ({
    raw: candidate,
    normalized: normalizeText(candidate),
  }));

  const byPrefix = normalizedCandidates.find((candidate) =>
    normalizedName.startsWith(candidate.normalized),
  );
  if (byPrefix) return titleCase(byPrefix.raw);

  const keywordMap: Array<{ regex: RegExp; category: string }> = [
    { regex: /cartucho|aguja|tinta|grip|tattoo|estencil|hectograf|pigmento/i, category: "Insumos de tattoo" },
    { regex: /vaper|smoking|paper|pipa|grinder|blunt|ocb|porro/i, category: "Smoking y fumadores" },
    { regex: /camisa|camiseta|gorra|gorro|pantalon|buso|maya|overs/i, category: "Prendas moska" },
    { regex: /aro|labret|nostril|ombligo|pezon|candonga|industrial|herradura|microdermal|joyeria/i, category: "Joyería básica" },
    { regex: /expansion|expancion|tunel|simulador/i, category: "Expansiones" },
  ];

  const keyword = keywordMap.find((entry) => entry.regex.test(name));
  return keyword ? keyword.category : "Sin categoría";
}

function extractCategories(lines: string[]): string[] {
  const start = lines.findIndex((line) => line.startsWith("## Categorías detectadas"));
  const end = lines.findIndex((line, idx) => idx > start && line.startsWith("## Referencias"));
  if (start === -1 || end === -1) return [];

  return lines
    .slice(start + 1, end)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
}

function parseReferenceLine(line: string, categories: string[]): ParsedRow | null {
  if (!line.startsWith("- ")) return null;
  if (line.includes("(desde captura)")) return null;

  const trimmed = line.slice(2).trim();
  const moneyMatches = [...trimmed.matchAll(/\$\s*-?[0-9\.,]+/g)];
  if (moneyMatches.length < 2) return null;

  const priceRaw = moneyMatches[0][0];
  const costRaw = moneyMatches[1][0];
  const quantityPart = trimmed
    .slice(moneyMatches[1].index! + moneyMatches[1][0].length)
    .trim();
  const quantityMatch = quantityPart.match(/^-?\d+/);
  if (!quantityMatch) return null;

  const namePart = trimmed.slice(0, moneyMatches[0].index).trim();
  const compactName = namePart.replace(/\s+/g, " ").trim();
  const tokens = compactName.split(" ");
  let dedupedName = compactName;
  if (tokens.length % 2 === 0) {
    const middle = tokens.length / 2;
    const firstHalf = tokens.slice(0, middle).join(" ");
    const secondHalf = tokens.slice(middle).join(" ");
    if (normalizeText(firstHalf) === normalizeText(secondHalf)) {
      dedupedName = firstHalf;
    }
  }

  const price = parseCopAmount(priceRaw);
  const originalCost = parseCopAmount(costRaw);
  const originalQty = parseQuantity(quantityMatch[0]);
  const issues: string[] = [];

  let cost = originalCost;
  if (cost < 0) {
    cost = 0;
    issues.push("cost_negative_clamped_to_zero");
  }

  let quantity = originalQty;
  if (quantity < 0) {
    quantity = 0;
    issues.push("quantity_negative_clamped_to_zero");
  }

  if (price <= 0) {
    issues.push("invalid_non_positive_price");
  }

  if (cost > price && price > 0) {
    cost = price;
    issues.push("cost_greater_than_price_clamped");
  }

  if (price > 0 && price < 100) {
    issues.push("low_price_outlier");
  }

  const normalizedName = normalizeText(dedupedName);
  return {
    rawLine: line,
    name: dedupedName,
    normalizedName,
    price,
    cost,
    quantity,
    category: pickCategory(dedupedName, categories),
    issues,
  };
}

function toCsv(rows: ParsedRow[]): string {
  const header = [
    "name",
    "normalized_name",
    "category",
    "price",
    "cost",
    "quantity",
    "issues",
  ];
  const escapeCsv = (value: string | number): string => {
    const stringified = String(value);
    if (stringified.includes(",") || stringified.includes("\"") || stringified.includes("\n")) {
      return `"${stringified.replaceAll("\"", "\"\"")}"`;
    }
    return stringified;
  };

  const body = rows.map((row) =>
    [
      row.name,
      row.normalizedName,
      row.category,
      row.price,
      row.cost,
      row.quantity,
      row.issues.join("|"),
    ]
      .map(escapeCsv)
      .join(","),
  );

  return [header.join(","), ...body].join("\n");
}

function makeSku(name: string): string {
  const digest = createHash("sha1").update(normalizeText(name)).digest("hex").slice(0, 8);
  return `TR30-${digest}`.toUpperCase();
}

async function main() {
  const sourcePath = resolve(process.cwd(), SOURCE_MD);
  const raw = readFileSync(sourcePath, "utf8");
  const lines = raw.split(/\r?\n/);
  const categories = extractCategories(lines);

  const parsedRows = lines
    .map((line) => parseReferenceLine(line, categories))
    .filter((row): row is ParsedRow => row !== null)
    .filter((row) => row.price > 0);

  const dedupedMap = new Map<string, ParsedRow>();
  for (const row of parsedRows) {
    const existing = dedupedMap.get(row.normalizedName);
    if (!existing) {
      dedupedMap.set(row.normalizedName, row);
      continue;
    }
    dedupedMap.set(row.normalizedName, {
      ...existing,
      quantity: existing.quantity + row.quantity,
      price: row.price,
      cost: row.cost,
      issues: [...new Set([...existing.issues, ...row.issues, "merged_duplicate_reference"])],
    });
  }

  const normalizedRows = Array.from(dedupedMap.values()).sort((a, b) =>
    a.name.localeCompare(b.name, "es"),
  );

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(OUTPUT_JSON, JSON.stringify(normalizedRows, null, 2));
  writeFileSync(OUTPUT_CSV, toCsv(normalizedRows));

  console.log(`✓ Normalizado: ${normalizedRows.length} referencias únicas`);
  console.log(`✓ JSON: ${OUTPUT_JSON}`);
  console.log(`✓ CSV: ${OUTPUT_CSV}`);

  if (NORMALIZE_ONLY) {
    console.log("Modo normalize-only: no se aplicaron cambios en DB.");
    return;
  }

  const [{ db }, schema] = await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/db/schema"),
  ]);
  const {
    businessMembers,
    businesses,
    inventoryBalances,
    inventoryMovements,
    locations,
    products,
  } = schema;

  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.slug, TARGET_BUSINESS_SLUG))
    .limit(1);
  if (!business) {
    throw new Error(`Business slug not found: ${TARGET_BUSINESS_SLUG}`);
  }

  const [location] = await db
    .select()
    .from(locations)
    .where(and(eq(locations.business_id, business.id), eq(locations.slug, TARGET_LOCATION_SLUG)))
    .limit(1);
  if (!location) {
    throw new Error(`Location slug not found for business ${TARGET_BUSINESS_SLUG}: ${TARGET_LOCATION_SLUG}`);
  }

  const [owner] = await db
    .select({ user_id: businessMembers.user_id })
    .from(businessMembers)
    .where(and(eq(businessMembers.business_id, business.id), eq(businessMembers.role, "owner")))
    .limit(1);
  if (!owner) {
    throw new Error(`No owner membership found for business ${TARGET_BUSINESS_SLUG}`);
  }

  const existingProducts = await db
    .select()
    .from(products)
    .where(eq(products.business_id, business.id));
  const byNormalizedName = new Map<string, (typeof existingProducts)[number]>();
  for (const product of existingProducts) {
    byNormalizedName.set(normalizeText(product.name), product);
  }

  const existingBalances = await db
    .select()
    .from(inventoryBalances)
    .where(eq(inventoryBalances.location_id, location.id));
  const balanceByProductId = new Map<number, (typeof existingBalances)[number]>();
  for (const balance of existingBalances) {
    balanceByProductId.set(balance.product_id, balance);
  }

  const stats: ImportStats = {
    parsed: normalizedRows.length,
    skipped: 0,
    createdProducts: 0,
    updatedProducts: 0,
    createdBalances: 0,
    updatedBalances: 0,
    omittedBalances: 0,
  };

  const runId = `treinta-${new Date().toISOString()}`;

  for (const row of normalizedRows) {
    let product = byNormalizedName.get(row.normalizedName);
    if (!product) {
      if (!DRY_RUN) {
        const [created] = await db
          .insert(products)
          .values({
            name: row.name,
            description: `Migrado desde Treinta (${runId})`,
            price: row.price,
            in_stock: row.quantity,
            user_uid: owner.user_id,
            category: row.category,
            business_id: business.id,
            sku: makeSku(row.name),
            cost_amount: row.cost,
            status: "active",
            kind: "product",
          })
          .returning();
        product = created;
      } else {
        product = {
          id: -1,
          name: row.name,
          description: null,
          price: row.price,
          in_stock: row.quantity,
          user_uid: owner.user_id,
          category: row.category,
          business_id: business.id,
          sku: makeSku(row.name),
          cost_amount: row.cost,
          status: "active",
          kind: "product",
          default_service_kind: null,
          created_at: null,
        };
      }
      byNormalizedName.set(row.normalizedName, product);
      stats.createdProducts += 1;
      console.log(`[CREATED_PRODUCT] ${row.name}`);
    } else {
      const shouldUpdate =
        product.price !== row.price ||
        (product.cost_amount ?? 0) !== row.cost ||
        (product.category ?? "") !== row.category;

      if (shouldUpdate) {
        if (!DRY_RUN) {
          await db
            .update(products)
            .set({
              price: row.price,
              cost_amount: row.cost,
              category: row.category,
              in_stock: row.quantity,
            })
            .where(eq(products.id, product.id));
        }
        stats.updatedProducts += 1;
        console.log(`[UPDATED_PRODUCT] ${row.name} reasons=price/cost/category`);
      } else {
        stats.skipped += 1;
        console.log(`[SKIPPED_PRODUCT] ${row.name} reason=no_changes`);
      }
    }

    const existingBalance = product.id < 0 ? undefined : balanceByProductId.get(product.id);
    if (!existingBalance) {
      if (!DRY_RUN) {
        await db.insert(inventoryBalances).values({
          business_id: business.id,
          location_id: location.id,
          product_id: product.id,
          quantity_on_hand: row.quantity,
          quantity_reserved: 0,
        });

        await db.insert(inventoryMovements).values({
          business_id: business.id,
          location_id: location.id,
          product_id: product.id,
          quantity_delta: row.quantity,
          type: "initial_import",
          source_type: "treinta_import",
          source_id: null,
          created_by_user_id: owner.user_id,
          notes: `Treinta import (${runId})`,
        });
      }
      stats.createdBalances += 1;
      console.log(`[CREATED_BALANCE] ${row.name} qty=${row.quantity}`);
      continue;
    }

    const delta = row.quantity - existingBalance.quantity_on_hand;
    if (delta === 0) {
      stats.omittedBalances += 1;
      console.log(`[OMITTED_BALANCE] ${row.name} reason=no_delta`);
      continue;
    }

    if (!DRY_RUN) {
      await db
        .update(inventoryBalances)
        .set({ quantity_on_hand: row.quantity, updated_at: new Date() })
        .where(eq(inventoryBalances.id, existingBalance.id));

      await db.insert(inventoryMovements).values({
        business_id: business.id,
        location_id: location.id,
        product_id: product.id,
        quantity_delta: delta,
        type: "adjustment",
        source_type: "treinta_import",
        source_id: null,
        created_by_user_id: owner.user_id,
        notes: `Treinta re-sync (${runId})`,
      });
    }

    stats.updatedBalances += 1;
    console.log(`[UPDATED_BALANCE] ${row.name} delta=${delta}`);
  }

  console.log("\nImport summary:");
  console.log(JSON.stringify(stats, null, 2));
  if (DRY_RUN) {
    console.log("Dry-run finalizado: no se persistieron cambios.");
  }
}

main().catch((error) => {
  console.error("Treinta import failed:", error);
  process.exit(1);
});
