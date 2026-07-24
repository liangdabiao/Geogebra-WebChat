/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("找不到 #root 挂载点");

render(() => <App />, root);
