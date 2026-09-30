import express from "express";
import { createApp } from "./service/app.js";

// Direct `express` import: the Vercel Express preset only accepts an entry
// file that imports express itself. Routes live in service/app.ts.
void express;

export default createApp();
