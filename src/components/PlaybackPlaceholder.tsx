import type {Series} from '../../shared/contracts';
import {Loading} from './ui';
import './PlaybackPlaceholder.css';
export default function PlaybackPlaceholder({series}:{series:Series}){
  return <div className="playback-placeholder" aria-busy="true">{series.cover&&<img src={series.cover} alt=""/>}<Loading text="正在准备画面…"/></div>;
}
