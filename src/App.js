import React from 'react';
import './App.css';
import MapComponent from './MapComponent';
import TriageChat from './components/TriageChat';

function App() {
  return (
    <div className="App">
      <aside className="App-sidebar">
        <TriageChat />
      </aside>
      <main className="App-main">
        <MapComponent />
      </main>
    </div>
  );
}

export default App;
