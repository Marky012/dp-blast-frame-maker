import React, { useState, useEffect } from 'react';
import StudentApp from './StudentApp.jsx';
import AdminApp from './AdminApp.jsx';

function isAdminRoute() {
  const path = window.location.pathname.replace(/\/+$/, '');
  const hash = window.location.hash.replace(/^#/, '').replace(/\/+$/, '');
  return path === '/admin' || hash === '/admin' || hash === 'admin';
}

export default function App() {
  const [isAdmin, setIsAdmin] = useState(isAdminRoute);

  useEffect(() => {
    const onRouteChange = () => setIsAdmin(isAdminRoute());
    window.addEventListener('popstate', onRouteChange);
    window.addEventListener('hashchange', onRouteChange);
    return () => {
      window.removeEventListener('popstate', onRouteChange);
      window.removeEventListener('hashchange', onRouteChange);
    };
  }, []);

  return isAdmin ? <AdminApp /> : <StudentApp />;
}

