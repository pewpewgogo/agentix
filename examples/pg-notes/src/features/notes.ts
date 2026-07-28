import { command, event, feature, port, query, s } from "@agentixdev/core";

/* ------------------------------------------------------------------ */
/* Domain records                                                     */
/* ------------------------------------------------------------------ */

export const Note = s.object({
  id: s.string({ min: 1 }),
  title: s.string({ min: 1, trim: true }),
  body: s.string(),
  createdAt: s.string({ min: 1 }),
});
export type Note = s.Infer<typeof Note>;

export const ArchivedNote = s.object({
  id: s.string({ min: 1 }),
  title: s.string({ min: 1 }),
  body: s.string(),
  createdAt: s.string({ min: 1 }),
  archivedAt: s.string({ min: 1 }),
});
export type ArchivedNote = s.Infer<typeof ArchivedNote>;

/* ------------------------------------------------------------------ */
/* Ports                                                              */
/* ------------------------------------------------------------------ */

/**
 * Hand-declared store-shaped port (rather than `port.store`) because the SQL
 * adapter carries semantics the generic store cannot express:
 *
 * - `save` is an UPSERT (`INSERT ... ON CONFLICT (id) DO UPDATE`) — the
 *   primary key, not application code, is the final uniqueness authority;
 * - `archive` is a transactional unit of work: it moves a row from `notes`
 *   to `notes_archive` atomically (BEGIN .. COMMIT lives in the adapter);
 * - `list`/`listArchived` promise a stable ORDER BY, which a Map-backed
 *   store never has to think about.
 *
 * The get/save/delete/list quartet keeps the exact `port.store` shape, so a
 * memory fake is a page of code (see notes.test.ts). The trade-off is
 * explicit: a hand-declared port does NOT get `.memory()` for free and is
 * not auto-faked by createTestApplication.
 */
export const NoteStore = port("noteStore", {
  get: port.read({ input: s.string({ min: 1 }), output: s.optional(Note) }),
  save: port.write({ input: Note, output: Note }),
  delete: port.write({ input: s.string({ min: 1 }), output: s.boolean() }),
  list: port.read({ input: s.object({}), output: s.array(Note) }),
  /** Atomic move notes -> notes_archive; undefined when the id is unknown. */
  archive: port.write({
    input: s.object({ id: s.string({ min: 1 }), archivedAt: s.string({ min: 1 }) }),
    output: s.optional(ArchivedNote),
  }),
  listArchived: port.read({ input: s.object({}), output: s.array(ArchivedNote) }),
});

/** Time is a declared capability so tests stay deterministic. */
export const NoteClock = port("noteClock", {
  now: port.time({ input: s.object({}), output: s.string({ min: 1 }) }),
});

/* ------------------------------------------------------------------ */
/* Events                                                             */
/* ------------------------------------------------------------------ */

export const NoteArchived = event(
  "notes.archived",
  1,
  s.object({ id: s.string({ min: 1 }), archivedAt: s.string({ min: 1 }) }),
);

/* ------------------------------------------------------------------ */
/* Operations                                                         */
/* ------------------------------------------------------------------ */

export const notes = feature("notes", {
  operations: {
    create: command({
      input: s.object({
        id: s.string({ min: 1, trim: true }),
        title: s.string({ min: 1, trim: true }),
        body: s.string(),
      }),
      output: Note,
      errors: {
        NOTE_ALREADY_EXISTS: { http: 409, details: { id: s.string() } },
      },
      permissions: ["notes:write"],
      http: { method: "POST", path: "/notes", status: 201 },
      effects: { load: NoteStore.get, now: NoteClock.now, save: NoteStore.save },
      async execute({ input, effects, fail }) {
        // Best-effort duplicate check for a friendly 409. Under a create race
        // the UPSERT still keeps exactly one row per id (last write wins);
        // see the README for the stricter claim-style alternative.
        if (await effects.load(input.id)) {
          return fail("NOTE_ALREADY_EXISTS", { id: input.id });
        }
        return effects.save({ ...input, createdAt: await effects.now({}) });
      },
    }),

    get: query({
      input: s.object({ id: s.string({ min: 1 }) }),
      output: Note,
      errors: { NOTE_NOT_FOUND: { http: 404, details: { id: s.string() } } },
      permissions: ["notes:read"],
      http: { method: "GET", path: "/notes/:id" },
      effects: { load: NoteStore.get },
      async execute({ input, effects, fail }) {
        return (await effects.load(input.id)) ?? fail("NOTE_NOT_FOUND", { id: input.id });
      },
    }),

    list: query({
      input: s.object({}),
      output: s.array(Note),
      permissions: ["notes:read"],
      http: { method: "GET", path: "/notes" },
      effects: { list: NoteStore.list },
      async execute({ effects }) {
        return effects.list({});
      },
    }),

    remove: command({
      input: s.object({ id: s.string({ min: 1 }) }),
      output: s.object({ id: s.string(), deleted: s.literal(true) }),
      errors: { NOTE_NOT_FOUND: { http: 404, details: { id: s.string() } } },
      permissions: ["notes:write"],
      http: { method: "DELETE", path: "/notes/:id" },
      effects: { delete: NoteStore.delete },
      async execute({ input, effects, fail }) {
        if (!(await effects.delete(input.id))) {
          return fail("NOTE_NOT_FOUND", { id: input.id });
        }
        return { id: input.id, deleted: true } as const;
      },
    }),

    /**
     * The unit-of-work showcase: the domain calls ONE effect and stays plain;
     * the adapter wraps DELETE + INSERT in a single transaction. Atomicity is
     * an adapter guarantee, not something execute() stitches together.
     */
    archive: command({
      input: s.object({ id: s.string({ min: 1 }) }),
      output: ArchivedNote,
      errors: { NOTE_NOT_FOUND: { http: 404, details: { id: s.string() } } },
      permissions: ["notes:write"],
      http: { method: "POST", path: "/notes/:id/archive" },
      effects: { now: NoteClock.now, archive: NoteStore.archive },
      emits: { archived: NoteArchived },
      async execute({ input, effects, emit, fail }) {
        const archived = await effects.archive({
          id: input.id,
          archivedAt: await effects.now({}),
        });
        if (archived === undefined) return fail("NOTE_NOT_FOUND", { id: input.id });
        emit.archived({ id: archived.id, archivedAt: archived.archivedAt });
        return archived;
      },
    }),

    listArchived: query({
      input: s.object({}),
      output: s.array(ArchivedNote),
      permissions: ["notes:read"],
      http: { method: "GET", path: "/notes/archived" },
      effects: { list: NoteStore.listArchived },
      async execute({ effects }) {
        return effects.list({});
      },
    }),
  },
});
