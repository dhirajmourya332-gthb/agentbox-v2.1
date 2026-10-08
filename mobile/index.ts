// Must run first: wires crypto.getRandomValues to the OS CSPRNG before anything uses it.
import "./src/polyfills";
import { registerRootComponent } from "expo";

import App from "./App";

registerRootComponent(App);
