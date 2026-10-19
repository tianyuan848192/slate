/* 官方目录（GET /api/skills），整个页面只取一次；失败了下次再取。
   items 是画风（画面长什么样），genres 是写作方法（剧本怎么组织）：两者互相独立，可以自由搭配。
   两类里都有管理员生成的（generated: true；画风带 thumb 缩略图链接和 uses 适用写作方法，写作方法带 group 分组）；beta: true 是内测中的，只返回给管理员 */

import { api } from './api.js';

let cache = null;
let items = [];
let genres = [];

export function loadSkills() {
  if (!cache) {
    cache = api.get('/skills')
      .then(r => {
        items = Array.isArray(r?.items) ? sortStyles(r.items) : [];
        genres = Array.isArray(r?.genres) ? r.genres : [];
        return items;
      })
      .catch(e => { cache = null; throw e; });
  }
  return cache;
}

export const skillById = id => items.find(s => s.id === id);
export const skillName = id => skillById(id)?.name || id;
/** 内测画风的说明：画风库卡片、详情和新建视频选画风时都用 */
export const BETA_HINT = '仅管理员可见，用来做测试片；公开发布后所有人都能用';

/** 分类按固定顺序排，目录里出现的其他分类排在后面 */
const CAT_ORDER = ['信息与图解', '图形与排版', '手绘与绘画', '东方传统', '印刷与版画', '材质与 3D', '卡通与动画', '游戏', '电影与时代'];
export function categories(list = items) {
  const extra = [...new Set(list.map(s => s.cat).filter(c => c && !CAT_ORDER.includes(c)))];
  return [...CAT_ORDER.filter(c => list.some(s => s.cat === c)), ...extra];
}

/** 画风按分类排，同一分类里内测的排在后面，其余照目录顺序 */
function sortStyles(list) {
  const cats = categories(list);
  const rank = s => { const i = cats.indexOf(s.cat); return i < 0 ? cats.length : i; };
  return [...list].sort((a, b) => rank(a) - rank(b) || !!a.beta - !!b.beta);
}

/* ---------- 写作方法 ---------- */

export const genreList = () => genres;
export const genreById = id => (id ? genres.find(g => g.id === id) : undefined);

/** 写作方法按分组排：讲解、宣传，目录里出现的其他分组排在后面 */
const GROUP_ORDER = ['讲解', '宣传'];
export function genreGroups(list = genres) {
  const names = [...GROUP_ORDER, ...new Set(list.map(g => g.group).filter(x => x && !GROUP_ORDER.includes(x)))];
  return names.map(name => ({ name, items: list.filter(g => g.group === name) })).filter(x => x.items.length);
}

/** 常和这个画风搭配的写作方法（哪些写作方法的 styles 里有它，加上生成画风 uses 里写的），按目录顺序 */
export function genresOfStyle(styleId) {
  const uses = skillById(styleId)?.uses || [];
  return genres.filter(g => (g.styles || []).includes(styleId) || uses.includes(g.id));
}

/** 常和这个写作方法搭配的画风 id：写作方法 styles 里列的按顺序在前，uses 里写了这个写作方法的生成画风按目录顺序跟在后面 */
export const stylesOfGenre = g => (g
  ? [...new Set([...(g.styles || []), ...items.filter(s => (s.uses || []).includes(g.id)).map(s => s.id)])]
  : []);
