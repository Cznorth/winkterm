import { defineConfig } from "orval";

export default defineConfig({
  winkterm: {
    input: {
      target: "http://localhost:8000/openapi.json",
    },
    output: {
      target: "src/lib/api/generated.ts",
      client: "react-query",
      override: {
        mutator: {
          path: "src/lib/axios.ts",
          name: "default",
        },
        query: {
          useQuery: true,
          useMutation: true,
        },
      },
    },
  },
});
