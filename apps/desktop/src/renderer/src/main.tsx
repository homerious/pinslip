import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { initI18n } from './i18n';
import './styles/global.css';

// 注意必须用 HashRouter：多窗口通过 index.html#/note/<id> 的 hash 路由区分视图，
// 生产环境 file:// 协议下 BrowserRouter 无法工作。
//
// 先完成 i18n 初始化（经 IPC 读语言偏好 + 系统 locale）再挂载，
// 避免界面先闪一帧占位语言再切换。
async function bootstrap() {
  await initI18n();
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <HashRouter>
        <App />
      </HashRouter>
    </React.StrictMode>,
  );
}

void bootstrap();
