import { createBrowserRouter } from "react-router-dom";
import Layout from "../layout.jsx";
import Home from "../pages/home.jsx";
import CreateAccount from "@/pages/create-account.jsx";
import Login from "../pages/login.jsx";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      {
        index: true,
        element: <Home />,
      },
      {
        path: "create-account",
        element: <CreateAccount />,
      },
      {
        path: "login",
        element: <Login />,
      },
    ],
  },
]);
