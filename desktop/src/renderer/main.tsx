import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { connectDesktop } from "./bridge.ts";
const element = document.getElementById("root");
if (!element) throw new Error("Missing app root");
createRoot(element).render(<App bridge={connectDesktop()} />);
