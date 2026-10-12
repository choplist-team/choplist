import { createBrowserRouter } from "react-router-dom";
import Layout from "../layout.jsx";
import Home from "../pages/home.jsx";
import CustomerMenu from "../pages/customer/CustomerMenu.jsx";
import CustomerCheckout from "@/pages/customer/CustomerCheckout.jsx";
import CustomerConfirmation from "@/pages/customer/CustomerConfirmation.jsx";
import OrderLookup from "@/pages/customer/OrderLookup.jsx";
import CreateAccount from "@/pages/seller/sign-up.jsx";
import Login from "@/pages/seller/login.jsx";
import SellerOnboarding from "../pages/seller/onboarding.jsx";

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
        path: "seller/sign-up/*",
        element: <CreateAccount />,
      },
      {
        path: "seller/sign-in/*",
        element: <Login />,
      },

      {
  path: "seller/onboarding",
  element: <SellerOnboarding />,
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
