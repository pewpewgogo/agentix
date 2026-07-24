import "reflect-metadata";

import { Module } from "@nestjs/common";

import { NotesController } from "./notes.controller.js";
import { NotesService } from "./notes.service.js";

@Module({
  controllers: [NotesController],
  providers: [NotesService],
})
export class NotesModule {}
