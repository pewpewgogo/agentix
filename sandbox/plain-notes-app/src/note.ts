import { z } from "zod";

export const NoteInput = z.strictObject({
  id: z.string().min(1),
  title: z.string().trim().min(1),
  body: z.string(),
});

export const Note = NoteInput.readonly();
export type Note = z.infer<typeof Note>;

export type NotesErrorCode = "NOTE_ALREADY_EXISTS" | "NOTE_NOT_FOUND";
export type NotesResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{
      ok: false;
      error: Readonly<{ code: NotesErrorCode; details: Readonly<{ id: string }> }>;
    }>;
