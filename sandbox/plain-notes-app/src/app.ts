import express from "express";

import { NotesService } from "./notes-service.js";

export const createNotesApp = (service = new NotesService()) => {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  app.post("/notes", (request, response) => {
    const result = service.create(request.body);
    response.status(result.ok ? 201 : 409).json(result);
  });
  app.get("/notes/:id", (request, response) => {
    const id = request.params["id"];
    if (id === undefined) {
      response.status(400).json({ ok: false, error: { code: "INVALID_ID" } });
      return;
    }
    const result = service.get(id);
    response.status(result.ok ? 200 : 404).json(result);
  });

  return app;
};
