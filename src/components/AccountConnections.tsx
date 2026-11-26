import { Avatar, Button, Space, Tag } from 'antd';
import { LinkOutlined, SwapOutlined } from '@ant-design/icons';
import type { AuthStatus } from '../../shared/types';

export function AccountConnections({ status, busy, onSwitch, onAdd }: {
  status: AuthStatus; busy: boolean; onSwitch: (id: string) => Promise<void>; onAdd: () => void;
}) {
  return <div className="account-connections">
    <p className="muted">添加多个 OneDrive 账号，切换后查看对应的文件和传输任务。</p>
    <div className="connected-accounts" aria-label="已授权账号">
      {status.accounts.map(account => <div className="saved-account" key={account.id}>
        <Avatar size={38} style={{ background: '#e8f0ff', color: '#1765e8' }}>{account.name.slice(0, 1).toUpperCase()}</Avatar>
        <div className="saved-account-identity"><strong>{account.name}</strong><span>{account.username}</span></div>
        {account.id === status.account?.id ? <Tag color="success">当前账号</Tag> : <Button icon={<SwapOutlined />} disabled={busy} onClick={() => void onSwitch(account.id)} aria-label={`切换到 ${account.username}`}>切换</Button>}
      </div>)}
    </div>
    <Space wrap>
      <Button type="primary" icon={<LinkOutlined />} disabled={busy || !status.configured || !!status.loginIssue} onClick={onAdd}>{status.accounts.length ? '添加账号' : '连接 OneDrive'}</Button>
      {status.account && <Button disabled={busy || !!status.loginIssue} onClick={onAdd}>重新授权</Button>}
    </Space>
  </div>;
}
