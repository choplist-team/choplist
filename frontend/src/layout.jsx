import { NavLink, Outlet } from "react-router-dom";

export default function Layout() {
  return (
    <main>
      <nav>
        <NavLink to="/home">Hello Project</NavLink>
        <Outlet />
      </nav>
    </main>
  );
}
