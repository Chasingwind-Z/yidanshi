export default defineAppConfig({
  pages: [
    'pages/index/index',
    'pages/record/index',
    'pages/shopping/index',
    'pages/timeline/index',
    'pages/recipe/index',
    'pages/settings/index',
  ],
  window: {
    backgroundColor: '#f4efe3',
    backgroundTextStyle: 'dark',
    navigationBarBackgroundColor: '#f4efe3',
    navigationBarTitleText: '一箪食',
    navigationBarTextStyle: 'black',
  },
  tabBar: {
    color: '#6f6454',
    selectedColor: '#b0392b',
    backgroundColor: '#fdfaf3',
    borderStyle: 'black',
    list: [
      { pagePath: 'pages/index/index', text: '食单' },
      { pagePath: 'pages/record/index', text: '记一餐' },
      { pagePath: 'pages/shopping/index', text: '买菜' },
      { pagePath: 'pages/timeline/index', text: '食历' },
    ],
  },
})
