import { loadAllLibraries } from "./steam/library";
import { runApp } from "./ui/app";

const accounts = await loadAllLibraries();
await runApp(accounts);
