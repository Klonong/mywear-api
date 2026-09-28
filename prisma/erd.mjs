// Generates docs/ERD.md (a Mermaid ER diagram) from prisma/schema.prisma. Run: npm run db:erd
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const schema = readFileSync(new URL('./schema.prisma', import.meta.url), 'utf8');
const enums = Object.fromEntries(
  [...schema.matchAll(/^enum (\w+) \{([\s\S]*?)^\}/gm)].map(([, name, body]) => [name, body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'))]),
);
const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map(([, name, body]) => ({
  name,
  fields: body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('@@'))
    .map((l) => {
      const [field, type, ...rest] = l.split(/\s+/);
      const attrs = rest.join(' ');
      return {
        field,
        base: type.replace(/[?[\]]/g, ''),
        optional: type.endsWith('?'),
        list: type.endsWith('[]'),
        attrs,
        relationName: attrs.match(/@relation\("(\w+)"/)?.[1],
        fk: attrs.match(/fields: \[([^\]]+)\]/)?.[1].split(',').map((s) => s.trim()),
      };
    }),
}));
const byName = Object.fromEntries(models.map((m) => [m.name, m]));

const entities = [];
const relations = [];
for (const m of models) {
  const fkFields = new Set(m.fields.flatMap((f) => f.fk ?? []));
  const scalars = m.fields.filter((f) => !byName[f.base]);
  entities.push(
    `  ${m.name} {\n` +
      scalars
        .map((f) => {
          const keys = [f.attrs.includes('@id') && 'PK', fkFields.has(f.field) && 'FK', f.attrs.includes('@unique') && 'UK'].filter(Boolean).join(', ');
          return `    ${f.base} ${f.field}${keys ? ` ${keys}` : ''}${f.optional ? ' "nullable"' : ''}`;
        })
        .join('\n') +
      `\n  }`,
  );
  // One line per relation, drawn from the side that holds the foreign key
  for (const f of m.fields.filter((x) => x.fk)) {
    const parent = byName[f.base];
    const back = parent.fields.find((x) => x.base === m.name && x !== f && x.relationName === f.relationName);
    const fkOptional = f.fk.some((name) => m.fields.find((x) => x.field === name)?.optional);
    const left = fkOptional ? '|o' : '||';
    const right = back?.list ? 'o{' : 'o|';
    relations.push(`  ${parent.name} ${left}--${right} ${m.name} : "${back?.field ?? f.field}"`);
  }
}

const doc = `# MyWear database ERD

<!-- Generated from prisma/schema.prisma by \`npm run db:erd\`. Do not edit by hand. -->

${models.length} tables, ${Object.keys(enums).length} enums. Money columns are integer IDR. \`PK\` primary key, \`FK\` foreign key, \`UK\` unique.
Crow's feet read as: \`||\` exactly one, \`|o\` zero or one, \`o{\` zero or many.

\`\`\`mermaid
erDiagram
${relations.join('\n')}

${entities.join('\n')}
\`\`\`

## Enums

| Enum | Values |
|---|---|
${Object.entries(enums)
  .map(([name, values]) => `| ${name} | ${values.map((v) => `\`${v}\``).join(', ')} |`)
  .join('\n')}

## Reading the model

- **Catalogue**: \`Product\` → \`ProductColor\` → \`Sku\` (one per colour and size, carries price and stock) and \`ProductImage\`. Sellable quantity is \`stock - reserved\`.
- **Orders** keep snapshots (\`OrderItem.nameSnapshot\`, \`Order.addressSnapshot\`) so later catalogue edits never rewrite history. \`OrderItem\` still links its \`Sku\`, which is why products are archived, not deleted.
- **Checkout** raises \`Sku.reserved\` until payment; \`Order.reservationExpiresAt\` drives the release job.
- **Carts** belong to a guest (\`token\` cookie) or a user (\`userId\`, one bag per user).
- \`Promotion\` and \`NewsletterSubscriber\` stand alone: orders store the promo \`code\`, not a foreign key.
`;

mkdirSync(new URL('../docs/', import.meta.url), { recursive: true });
writeFileSync(new URL('../docs/ERD.md', import.meta.url), doc);
console.log(`docs/ERD.md: ${models.length} tables, ${relations.length} relations, ${Object.keys(enums).length} enums`);
