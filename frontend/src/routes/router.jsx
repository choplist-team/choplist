import { createBrowserRouter } from "react-router-dom";
import Layout from "../layout.jsx";
import Home from "../pages/home.jsx";

import CustomerMenu from "../pages/customer/CustomerMenu.jsx";
import CustomerCheckout from "@/pages/customer/CustomerCheckout.jsx";
import CustomerConfirmation from "@/pages/customer/CustomerConfirmation.jsx";
import OrderLookup from "@/pages/customer/OrderLookup.jsx";

import CreateAccount from "../pages/seller/sign-up.jsx";
import Login from "../pages/seller/login.jsx";
import SellerOnboarding from "../pages/seller/onboarding.jsx";
import SellerDashboard from "../pages/seller/SellerDashboard.jsx";
import CreateMenu from "../pages/seller/CreateMenu.jsx";
import SellerOrders from "../pages/seller/SellerOrders.jsx";
import EditMenu from "../pages/seller/EditMenu.jsx";

import ProtectedRoute from "./ProtectedRoute.jsx";
import NotFound from "./NotFound.jsx";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      {
        index: true,
        element: <Home />,
      },

      // Public seller authentication
      {
        path: "seller/sign-up/*",
        element: <CreateAccount />,
      },
      {
        path: "seller/sign-in/*",
        element: <Login />,
      },

      {
        element: <ProtectedRoute />,
        children: [
          {
            path: "seller/onboarding",
            element: <SellerOnboarding />,
          },
          {
            path: "seller/dashboard",
            element: <SellerDashboard />,
          },
          {
            path: "seller/menu/new",
            element: <CreateMenu />,
          },
          {
            path: "seller/menu/:id/edit",
            element: <EditMenu />,
          },
          {
            path: "seller/orders",
            element: <SellerOrders />,
          },
        ],
      },

      {
        path: "shop/:slug",
        element: <CustomerMenu />,
      },
      {
        path: "shop/:slug/checkout",
        element: <CustomerCheckout />,
      },
      {
        path: "shop/:slug/confirmation",
        element: <CustomerConfirmation />,
      },
      {
        path: "order-lookup",
        element: <OrderLookup />,
      },

      {
        path: "*",
        element: <NotFound />,
      },
    ],
  },
]);
