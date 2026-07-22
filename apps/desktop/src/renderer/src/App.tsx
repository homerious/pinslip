import { Route, Routes } from 'react-router-dom';
import NoteView from './views/NoteView';
import QuickCaptureView from './views/QuickCaptureView';
import MainView from './views/MainView';

/** 每个窗口通过 hash 路由加载对应视图（见 src/main/windows/view-helper.ts） */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<MainView />} />
      <Route path="/note/:noteId" element={<NoteView />} />
      <Route path="/quick-capture" element={<QuickCaptureView />} />
    </Routes>
  );
}
