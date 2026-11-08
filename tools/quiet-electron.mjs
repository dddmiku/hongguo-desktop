import {_electron as electron} from '@playwright/test';

/** Keep automated playback silent even when a test restores an audible volume setting. */
export const quietElectron={
  async launch(options){
    const instance=await electron.launch({...options,args:[...(options.args||[]),'--mute-audio']});
    try{
      await instance.firstWindow();
      await instance.evaluate(({app,webContents})=>{
        app.on('web-contents-created',(_event,contents)=>contents.setAudioMuted(true));
        for(const contents of webContents.getAllWebContents())contents.setAudioMuted(true);
        if(!app.commandLine.hasSwitch('mute-audio')||webContents.getAllWebContents().some(contents=>!contents.isAudioMuted()))throw new Error('测试窗口静音未生效');
      });
      return instance;
    }catch(error){await instance.close().catch(()=>{});throw error;}
  },
};
