import { FileExcelOutlined, FileImageOutlined, FileOutlined, FilePdfOutlined, FileTextOutlined, FileWordOutlined, FileZipOutlined, FolderFilled, VideoCameraOutlined } from '@ant-design/icons';
import type { DriveItem } from '../../shared/types';

export function FileIcon({ item, large = false }: { item: Pick<DriveItem, 'name' | 'folder'>; large?: boolean }) {
  if (item.folder) return <span className={`file-icon folder ${large ? 'large' : ''}`}><FolderFilled /></span>;
  const extension = item.name.split('.').pop()?.toLowerCase() || '';
  const [Icon, tone] = /^(png|jpe?g|webp|gif|svg|heic)$/.test(extension) ? [FileImageOutlined, 'purple'] : extension === 'pdf' ? [FilePdfOutlined, 'red'] : /^(docx?|rtf)$/.test(extension) ? [FileWordOutlined, 'blue'] : /^(xlsx?|csv)$/.test(extension) ? [FileExcelOutlined, 'green'] : /^(zip|rar|7z|tar|gz)$/.test(extension) ? [FileZipOutlined, 'orange'] : /^(mp4|mov|webm|avi)$/.test(extension) ? [VideoCameraOutlined, 'purple'] : /^(txt|md|json|js|ts|html|css)$/.test(extension) ? [FileTextOutlined, 'blue'] : [FileOutlined, 'gray'];
  return <span className={`file-icon ${tone} ${large ? 'large' : ''}`}><Icon /></span>;
}
