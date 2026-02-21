const { runLearnWorkflow } = require("./stockpulse_core");

runLearnWorkflow().catch((err) => {
  console.error("delivery_learn failed:", err.message);
  process.exit(1);
});
