import { Outlet } from 'react-router-dom'
import { Register } from '../pages/Register'

/** Keeps the register mounted; child routes (e.g. settings) render as overlays via Outlet. */
export function TillLayout() {
  return (
    <>
      <Register />
      <Outlet />
    </>
  )
}
