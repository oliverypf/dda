@Component
export struct LocalKnowledgePanel {
  @Prop instructions: string = '';
  @Prop memories: string[] = [];
  @Prop skills: string[] = [];
  @State private draftInstructions: string = '';
  @State private newMemory: string = '';
  @State private newSkill: string = '';
  onInstructions: (text: string) => void = () => {};
  onChangeList: (isSkill: boolean, items: string[]) => void = () => {};
  onUseSkill: (text: string) => void = () => {};

  aboutToAppear(): void {
    this.draftInstructions = this.instructions;
  }

  @Builder
  private textList(isSkill: boolean, items: string[]) {
    Text(isSkill ? '常用任务提示' : '长期记忆').fontSize(16).fontWeight(FontWeight.Medium)
      .fontColor($r('app.color.wb_text'));
    Text(isSkill ? '选用后会填入任务输入框。' : '以下内容会随本机任务发送给当前模型。')
      .fontSize(12).fontColor($r('app.color.wb_secondary'));
    ForEach(items, (item: string) => {
      Row({ space: 6 }) {
        Text(item).layoutWeight(1).fontSize(13).fontColor($r('app.color.wb_text')).copyOption(CopyOptions.InApp);
        if (isSkill) {
          Button('使用').fontSize(12).height(32).onClick(() => this.onUseSkill(item));
        }
        Button('移除').fontSize(12).height(32).fontColor($r('app.color.wb_secondary'))
          .backgroundColor($r('app.color.wb_hover'))
          .onClick(() => this.onChangeList(isSkill, items.filter((value: string) => value !== item)));
      }.width('100%').padding(8).backgroundColor($r('app.color.wb_surface')).borderRadius(6);
    }, (item: string) => item);
    TextArea({ text: isSkill ? this.newSkill : this.newMemory, placeholder: isSkill ? '输入可复用的任务提示' : '记录项目约定或偏好' })
      .fontSize(13).height(64).maxLength(2000).fontColor($r('app.color.wb_text')).backgroundColor($r('app.color.wb_surface'))
      .onChange((text: string) => { if (isSkill) { this.newSkill = text; } else { this.newMemory = text; } });
    Button(isSkill ? '添加提示' : '添加记忆').height(34).fontSize(13)
      .enabled((isSkill ? this.newSkill : this.newMemory).trim().length > 0)
      .onClick(() => {
        const value = (isSkill ? this.newSkill : this.newMemory).trim();
        if (!items.includes(value)) { this.onChangeList(isSkill, items.concat([value])); }
        if (isSkill) { this.newSkill = ''; } else { this.newMemory = ''; }
      });
  }

  build() {
    Column({ space: 10 }) {
      Text('自定义指令').fontSize(16).fontWeight(FontWeight.Medium).fontColor($r('app.color.wb_text'));
      TextArea({ text: this.draftInstructions, placeholder: '例如：回答使用中文，修改后说明验证结果。' })
        .height(84).maxLength(8000).fontSize(13).fontColor($r('app.color.wb_text')).backgroundColor($r('app.color.wb_surface'))
        .onChange((value: string) => { this.draftInstructions = value; });
      Button('保存指令').height(34).fontSize(13).enabled(this.draftInstructions !== this.instructions)
        .onClick(() => this.onInstructions(this.draftInstructions));
      Divider().color($r('app.color.wb_border'));
      this.textList(false, this.memories);
      Divider().color($r('app.color.wb_border'));
      this.textList(true, this.skills);
    }.width('100%').alignItems(HorizontalAlign.Start);
  }
}
