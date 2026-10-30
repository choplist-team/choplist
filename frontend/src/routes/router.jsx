import { createBrowserRouter } from "react-router-dom";
import Layout from "../layout.jsx";

import ProtectedRoute from "./ProtectedRoute.jsx";
import RequireSellerProfile from "./RequireSellerProfile.jsx";
import RequireAdmin from "./RequireAdmin.jsx";

// Converts a dynamic import into a React Router lazy route.
const lazyPage = (importer) => async () => ({
  Component: (await importer()).default,
});

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      {
        index: true,
        lazy: lazyPage(() => import("../pages/home.jsx")),
      },

      // Public seller authentication
      {
        path: "seller/sign-up/*",
        lazy: lazyPage(() => import("../pages/seller/sign-up.jsx")),
      },
      {
        path: "seller/sign-in/*",
        lazy: lazyPage(() => import("../pages/seller/login.jsx")),
      },

      // Protected seller routes
      {
        element: <ProtectedRoute />,
        children: [
          {
            path: "seller/onboarding",
            lazy: lazyPage(() => import("../pages/seller/onboarding.jsx")),
          },
          {
            path: "seller/dashboard",
            lazy: lazyPage(() => import("../pages/seller/SellerDashboard.jsx")),
          },
          {
            path: "seller/profile/edit",
            lazy: lazyPage(() => import("../pages/seller/EditProfile.jsx")),
          },
          {
            element: <RequireSellerProfile />,
            children: [
              {
                path: "seller/menu/new",
                lazy: lazyPage(() => import("../pages/seller/CreateMenu.jsx")),
              },
              {
                path: "seller/menu/:id/edit",
                lazy: lazyPage(() => import("../pages/seller/EditMenu.jsx")),
              },
              {
                path: "seller/orders",
                lazy: lazyPage(() =>
                  import("../pages/seller/SellerOrders.jsx")
                ),
              },
              {
                path: "seller/prep",
                lazy: lazyPage(() => import("../pages/seller/Prep.jsx")),
              },
              {
                path: "seller/delivery",
                lazy: lazyPage(() => import("../pages/seller/Delivery.jsx")),
              },
            ],
          },
        ],
      },

      // Customer routes
      {
        path: "shop/:slug",
        lazy: lazyPage(() => import("../pages/customer/CustomerMenu.jsx")),
      },
      {
        path: "shop/:slug/checkout",
        lazy: lazyPage(() => import("../pages/customer/CustomerCheckout.jsx")),
      },
      {
        path: "shop/:slug/confirmation",
        lazy: lazyPage(() =>
          import("../pages/customer/CustomerConfirmation.jsx")
        ),
      },
      {
        path: "order-lookup",
        lazy: lazyPage(() => import("../pages/customer/OrderLookup.jsx")),
      },

      // Admin sign-in (public). There is no admin sign-up: admins are the
      // accounts listed in the API's ADMIN_CLERK_USER_IDS.
      {
        path: "admin/sign-in/*",
        lazy: lazyPage(() => import("../pages/admin/AdminSignIn.jsx")),
      },

      // Admin routes, behind the admin check
      {
        element: <RequireAdmin />,
        children: [
          {
            path: "admin",
            lazy: lazyPage(() => import("../pages/admin/AdminLayout.jsx")),
            children: [
              {
                index: true,
                lazy: lazyPage(() => import("../pages/admin/AdminOverview.jsx")),
              },
              {
                path: "sellers",
                lazy: lazyPage(() => import("../pages/admin/AdminSellers.jsx")),
              },
              {
                path: "sellers/:sellerId",
                lazy: lazyPage(() => import("../pages/admin/SellerDetails.jsx")),
              },
              {
                path: "orders",
                lazy: lazyPage(() => import("../pages/admin/AdminOrders.jsx")),
              },
              {
                path: "analytics",
                lazy: lazyPage(() => import("../pages/admin/AdminAnalytics.jsx")),
              },

              {
                path: "system-health",
                lazy: lazyPage(() =>
                  import("../pages/admin/AdminSystemHealth.jsx")
                ),
              },
            ],
          },
        ],
      },

      {
        path: "*",
        lazy: lazyPage(() => import("./NotFound.jsx")),
      },
    ],
  },
]);
