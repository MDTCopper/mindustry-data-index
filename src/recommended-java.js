// Mindustry 推荐 Java 版本规则：游戏主版本号（jar 内 version.properties 的 number）→ Java 大版本
// 与启动器 JavaCompat 保持一致；数据放在仓库里，启动器/网站不用各自硬编码

export const RECOMMENDED_JAVA_REL_PATH = 'mindustry/recommended-java.json';

export const RECOMMENDED_JAVA = {
  defaultJavaMajor: 8,
  loaderMinJavaMajor: 17,
  rules: [
    { minRelease: 6, javaMajor: 11 },
    { minRelease: 7, javaMajor: 17 },
  ],
};

export function buildRecommendedJavaFile({ now }) {
  return {
    formatVersion: 1,
    generatedAt: now,
    source: 'Mindustry jar version.properties number; Copper JavaCompat rules',
    defaultJavaMajor: RECOMMENDED_JAVA.defaultJavaMajor,
    loaderMinJavaMajor: RECOMMENDED_JAVA.loaderMinJavaMajor,
    rules: RECOMMENDED_JAVA.rules,
  };
}
