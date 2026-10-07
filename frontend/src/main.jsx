import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { queryClient } from "./lib/query-client";
import { QueryClientProvider } from "@tanstack/react-query";
// import { ClerkProvider } from "@clerk/react-router";
import { RouterProvider } from "react-router-dom";
import { router } from "./routes/router";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    {/* <ClerkProvider publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}> */}
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    {/* </ClerkProvider> */}
  </StrictMode>
);


