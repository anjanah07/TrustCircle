import { migrate, closeDB } from "./db";
await migrate();
console.log("Schema ready.");
await closeDB();
