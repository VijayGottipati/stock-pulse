const { runFullWorkflow } = require("./stockpulse_core");

runFullWorkflow().catch((err) => {
  console.error("stockpulse_sync failed:", err.message);
  process.exit(1);
});
