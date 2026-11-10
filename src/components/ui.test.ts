import {describe,expect,it} from 'vitest';
import {message} from './ui';

describe('用户可读的错误提示',()=>{
  it('Electron 远程调用错误保留业务提示并移除 IPC 包装',()=>{
    const failure=new Error("Error invoking remote method 'api:request': Error: 暂时无法搜索短剧");
    expect(message(failure)).toBe('暂时无法搜索短剧');
  });
  it('双引号和嵌套远程调用包装也保留最内层业务提示',()=>{
    expect(message('Error invoking remote method "api:request": Error: Error invoking remote method \'catalog:search\': Error: 搜索暂时不可用，请重试')).toBe('搜索暂时不可用，请重试');
  });
  it('普通业务错误及其标点保持原样',()=>{
    expect(message(new Error('暂时无法搜索短剧：服务维护中'))).toBe('暂时无法搜索短剧：服务维护中');
    expect(message('请报告 Error invoking remote method 错误')).toBe('请报告 Error invoking remote method 错误');
  });
});
