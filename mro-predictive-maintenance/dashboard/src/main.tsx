import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@fontsource-variable/inter";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles/tokens.css";
import "./styles/components.css";
import "./styles/shell.css";
import "./styles/features.css";
import "./styles/polish.css";
import "./styles/material.css";
import { ToastProvider } from "./components/ui/feedback";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("root element not found");
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </React.StrictMode>,
);
