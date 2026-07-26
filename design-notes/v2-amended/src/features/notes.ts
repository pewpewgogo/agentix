import { command, feature, port, query, s } from "@agentix/core";

export const Note = s.object({
  id: s.string({ min: 1 }),
  title: s.string({ min: 1, trim: true }),
  body: s.string(),
});
export type Note = s.Infer<typeof Note>;

export const NoteStorage = port.store("noteStorage", Note);

export const notes = feature("notes", {
  ports: [NoteStorage],
  operations: {
    create: command({
      input: Note,
      output: Note,
      errors: { NOTE_ALREADY_EXISTS: { id: s.string() } },
      http: {
        method: "POST",
        path: "/notes",
        status: 201,
        errorStatus: { NOTE_ALREADY_EXISTS: 409 },
      },
      effects: { load: NoteStorage.get, save: NoteStorage.save },
      async execute({ input, effects, fail }) {
        if (await effects.load(input.id)) {
          return fail("NOTE_ALREADY_EXISTS", { id: input.id });
        }
        return effects.save(input);
      },
    }),
    get: query({
      input: s.object({ id: s.string({ min: 1 }) }),
      output: Note,
      errors: { NOTE_NOT_FOUND: { id: s.string() } },
      http: { method: "GET", path: "/notes/:id", errorStatus: { NOTE_NOT_FOUND: 404 } },
      effects: { load: NoteStorage.get },
      async execute({ input, effects, fail }) {
        return (await effects.load(input.id)) ?? fail("NOTE_NOT_FOUND", { id: input.id });
      },
    }),
  },
});
