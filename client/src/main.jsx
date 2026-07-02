import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './index.css';
import FounderHome from './pages/FounderHome.jsx';
import FounderTask from './pages/FounderTask.jsx';
import FounderReport from './pages/FounderReport.jsx';
import Attempt from './pages/Attempt.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<FounderHome />} />
        <Route path="/founder" element={<FounderHome />} />
        <Route path="/founder/tasks/:taskId" element={<FounderTask />} />
        <Route path="/founder/attempts/:attemptId" element={<FounderReport />} />
        <Route path="/attempt/:taskId" element={<Attempt />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
