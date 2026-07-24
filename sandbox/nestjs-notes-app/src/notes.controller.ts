import "reflect-metadata";

import {
  Body,
  Controller,
  Get,
  Param,
  Post,
} from "@nestjs/common";

import { NotesService } from "./notes.service.js";

@Controller("notes")
export class NotesController {
  public constructor(private readonly notes: NotesService) {}

  @Post()
  public create(@Body() input: unknown) {
    return this.notes.create(input);
  }

  @Get(":id")
  public get(@Param("id") id: string) {
    return this.notes.get(id);
  }
}
