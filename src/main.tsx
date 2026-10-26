import ReactDOM from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import 'antd/dist/reset.css';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#1765e8', colorInfo: '#1765e8', borderRadius: 8, fontSize: 14, colorText: '#233044', colorTextSecondary: '#7c879b', colorBorder: '#e4e8ef', fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif' }, components: { Button: { controlHeight: 36, primaryShadow: '0 3px 7px rgba(23,101,232,.12)' }, Table: { headerBg: '#f8faff', headerColor: '#79859a', rowHoverBg: '#f6f9ff' } } }}>
    <AntApp><App /></AntApp>
  </ConfigProvider>
);
