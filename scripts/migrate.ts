import { loadConfig } from "../src/config";
import { createStore } from "../src/db/client";
import { initializeStore } from "../src/server/initialize";

const config = loadConfig();
const store = await createStore(config);
try {
  await initializeStore(config, store);
  console.log("Database initialization complete.");
} finally {
  await store.close();
}
