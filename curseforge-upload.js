const { runAction } = require("./upload");

// core v3 exposes ESM exports; dynamic import keeps this entrypoint CommonJS.
void import(/* webpackMode: "eager" */ "@actions/core").then((core) =>
  runAction(core),
);
