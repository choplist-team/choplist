import { createBrowserRouter } from "react-router-dom";
import Layout from "../layout.jsx";
import Home from "../pages/home.jsx";
import CustomerMenu from "../pages/customer/CustomerMenu.jsx";
import CustomerCheckout from "@/pages/customer/CustomerCheckout.jsx";
import CustomerConfirmation from "@/pages/customer/CustomerConfirmation.jsx";
import OrderLookup from "@/pages/customer/OrderLookup.jsx";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      {
        index: true,
        element: <Home />,
      },
    ],
  },

  {
    path: "/shop/:slug",
    element: <CustomerMenu />,
  },

  {
    path: "/shop/:slug/checkout",
    element: <CustomerCheckout />,
  },

  {
    path: "/shop/:slug/confirmation",
    element: <CustomerConfirmation />,
  },
  {
    path: "/order-lookup",
    element: <OrderLookup />,
  },
]);
