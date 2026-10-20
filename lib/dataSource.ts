/** Active catalogue: "mock" (default) or "cdse" (live Copernicus). Inlined at build time. */
export const dataSource: "mock" | "cdse" =
  process.env.NEXT_PUBLIC_DATA_SOURCE === "cdse" ? "cdse" : "mock";
