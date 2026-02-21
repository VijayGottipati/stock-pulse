const { runHourlyWorkflow } = require("./stockpulse_core");

runHourlyWorkflow().catch((err) => {
  console.error("hourly_decide_act failed:", err.message);
  process.exit(1);
});
