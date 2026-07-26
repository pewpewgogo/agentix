import { s } from "../packages/core/src/index.js";
const Item = s.object({ id: s.string(), qty: s.number() });
const Payload = s.object({ id: s.string(), lines: s.array(Item) });
const raw = { id: "o1", lines: Array.from({ length: 100 }, (_, i) => ({ id: `l${i}`, qty: 1 })) };
const parsed = Payload.safeParse(raw) as any;
console.log("detached root:", parsed.data !== raw, "detached item:", parsed.data.lines[0] !== raw.lines[0], "detached array:", parsed.data.lines !== raw.lines);

// time safeParse alone
for (let i=0;i<500;i++) Payload.safeParse(raw);
let t = performance.now(); for (let i=0;i<2000;i++) Payload.safeParse(raw);
console.log("safeParse:", ((performance.now()-t)*1000/2000).toFixed(2), "µs");

// snapshot walk copied from application.ts
const isStructuredContainer = (v: unknown): v is object => typeof v === "object" && v !== null && (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const createStructuredContainer = (v: object): object => Array.isArray(v) ? [] : {};
const snapshotStructuredValue = (value: unknown, freeze: boolean): unknown => {
  if (!isStructuredContainer(value)) return value;
  const root = createStructuredContainer(value);
  const snapshots = new WeakMap<object, object>([[value, root]]);
  const pending: object[] = [value];
  const created: object[] = [root];
  while (pending.length > 0) {
    const source = pending.pop()!; const target = snapshots.get(source)!;
    for (const key of Reflect.ownKeys(source)) {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (descriptor?.enumerable !== true) continue;
      const sourceValue = Reflect.get(source, key);
      let snapshotValue = sourceValue;
      if (isStructuredContainer(sourceValue)) {
        const existing = snapshots.get(sourceValue);
        if (existing !== undefined) snapshotValue = existing;
        else { const child = createStructuredContainer(sourceValue); snapshots.set(sourceValue, child); pending.push(sourceValue); created.push(child); snapshotValue = child; }
      }
      Object.defineProperty(target, key, { configurable: true, enumerable: true, value: snapshotValue, writable: true });
    }
  }
  if (freeze) for (const o of created) Object.freeze(o);
  return root;
};
const p = parsed.data;
for (let i=0;i<500;i++) snapshotStructuredValue(p, false);
t = performance.now(); for (let i=0;i<2000;i++) snapshotStructuredValue(p, false);
console.log("snapshot(prod):", ((performance.now()-t)*1000/2000).toFixed(2), "µs");
t = performance.now(); for (let i=0;i<2000;i++) structuredClone(p);
console.log("structuredClone:", ((performance.now()-t)*1000/2000).toFixed(2), "µs");
