import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";

const link = document.createElement("link");
link.rel = "stylesheet";
link.href = "https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800&family=Outfit:wght@400;600;700&family=JetBrains+Mono:wght@400;500&display=swap";
document.head.appendChild(link);

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

