import { createHttpHandler } from "@agentixdev/adapters-http";
import { createApplication } from "@agentixdev/core";

import { notes, NoteStorage } from "./features/notes.js";

export const createNotesApp = () => {
  const app = createApplication({
    features: [notes],
    adapters: [NoteStorage.memory()],
  });
  return { app, handler: createHttpHandler(app) };
};
