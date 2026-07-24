import { Injectable } from "@nestjs/common";

import {
  Note,
  NoteInput,
  type NotesResult,
} from "./note.js";

@Injectable()
export class NotesService {
  readonly #notes = new Map<string, Note>();

  public create(input: unknown): NotesResult<Note> {
    const note = Note.parse(NoteInput.parse(input));
    if (this.#notes.has(note.id)) {
      return {
        ok: false,
        error: { code: "NOTE_ALREADY_EXISTS", details: { id: note.id } },
      };
    }
    this.#notes.set(note.id, note);
    return { ok: true, value: note };
  }

  public get(id: string): NotesResult<Note> {
    const note = this.#notes.get(id);
    return note === undefined
      ? { ok: false, error: { code: "NOTE_NOT_FOUND", details: { id } } }
      : { ok: true, value: note };
  }
}
