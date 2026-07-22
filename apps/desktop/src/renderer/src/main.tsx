import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import './styles/global.css';

// 注意必须用 HashRouter：多窗口通过 index.html#/note/<id> 的 hash 路由区分视图，
// 生产环境 file:// 协议下 BrowserRouter 无法工作。
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
